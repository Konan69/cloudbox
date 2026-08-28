// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as AWSRegion from "alchemy/AWS/Region";
import * as Output from "alchemy/Output";
import * as Random from "alchemy/Random";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { renderFetchWrapper, renderHostBootstrap } from "./src/bootstrap/render-host.ts";
import { renderUserData } from "./src/bootstrap/render.ts";
import type { AwsCloudboxConfig, CloudboxConfig, GcpCloudboxConfig } from "./src/config.ts";
import { loadConfig } from "./src/config.ts";
import * as GCP from "./src/gcp/index.ts";

class DeploymentInputError extends Data.TaggedError("DeploymentInputError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), path.slice(2))
    : NodePath.resolve(path);

const gcpDataDiskName = (config: GcpCloudboxConfig): string => `cloudbox-${config.name}-data`;
const gcpRegion = (zone: string): string => zone.replace(/-[a-z]$/u, "");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const shortHash = (value: string): string => sha256(value).slice(0, 10);
const gcpBucketName = (config: GcpCloudboxConfig, purpose: string): string =>
  `cloudbox-${config.name.slice(0, 32)}-${purpose}-${shortHash(`${config.gcp.project}:${config.name}:${purpose}`)}`;
const gcpWakeServiceName = (config: GcpCloudboxConfig): string =>
  `cloudbox-${config.name.slice(0, 24)}-wake-${shortHash(`${config.gcp.project}:${config.name}:service`).slice(0, 8)}`;

const deploymentInputs = (config: CloudboxConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const readInput = (path: string, buildCommand: string) =>
      fs.readFileString(path).pipe(
        Effect.mapError(
          (cause) =>
            new DeploymentInputError({
              message: `${path} is required; run ${buildCommand}`,
              cause,
            }),
        ),
      );
    const sshPublicKey = yield* fs.readFileString(expandHome(config.sshPublicKeyPath)).pipe(
      Effect.mapError(
        (cause) =>
          new DeploymentInputError({
            message: `Cannot read sshPublicKeyPath ${config.sshPublicKeyPath}`,
            cause,
          }),
      ),
    );
    if (config.provider === "aws") {
      const startupScript = renderUserData({
        config,
        sshPublicKey,
        idleBundle: yield* readInput("dist/idle-aws.mjs", "pnpm build:idle:aws"),
      });
      if (Buffer.byteLength(startupScript, "utf8") > 16 * 1024) {
        return yield* Effect.fail(
          new DeploymentInputError({
            message: "Rendered EC2 user data exceeds the 16 KiB launch limit",
          }),
        );
      }
      return { sshPublicKey, startupScript };
    }
    const idleBundle = yield* readInput("dist/idle.mjs", "pnpm build:idle");
    const machinesBundle = yield* readInput("dist/machines.mjs", "pnpm build:machines");
    const hostBootstrap = renderHostBootstrap({
      boxUser: config.boxUser,
      name: config.name,
      project: config.gcp.project,
      zone: config.gcp.zone,
      zfsDataDevice: `/dev/disk/by-id/google-${gcpDataDiskName(config)}`,
      idleMinutes: config.idleMinutes,
      t3Port: 3773,
      t3: {
        repoUrl: config.t3.repoUrl,
        branch: config.t3.branch,
        relayUrl: "https://relay.t3.codes",
        clerkPublishableKey: "pk_live_Y2xlcmsudDMuY29kZXMk",
        clerkCliOauthClientId: "hzxSgY2cH10sDU2r",
      },
    });
    const wakeBundle = yield* readInput("dist/wake-service.mjs", "pnpm build:wake");
    return { sshPublicKey, hostBootstrap, idleBundle, machinesBundle, wakeBundle };
  });

const awsProviders = Layer.unwrap(
  loadConfig("cloudbox.json").pipe(
    Effect.map((config) =>
      config.provider === "aws"
        ? Layer.mergeAll(AWS.providers(), AWSRegion.of(config.region))
        : Layer.empty,
    ),
    Effect.orDie,
  ),
);

const gcpProviders = Layer.unwrap(
  loadConfig("cloudbox.json").pipe(
    Effect.map((config) =>
      config.provider === "gcp"
        ? GCP.providers({ project: config.gcp.project, credentials: config.gcp.credentials })
        : Layer.empty,
    ),
    Effect.orDie,
  ),
);

// Alchemy.makeRandom (wake bearer secret) is served by Alchemy's built-in Random
// provider, which is not part of any cloud provider layer.
const cloudProviders = Layer.mergeAll(awsProviders, gcpProviders, Random.RandomProvider());

const makeInstanceTemplate = (config: AwsCloudboxConfig, userData: string) =>
  JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Cloudbox hibernating personal development instance",
    Parameters: {
      ImageId: {
        Type: "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>",
        Default: "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
      },
      SubnetId: { Type: "AWS::EC2::Subnet::Id" },
      SecurityGroupId: { Type: "AWS::EC2::SecurityGroup::Id" },
      KeyName: { Type: "AWS::EC2::KeyPair::KeyName" },
      InstanceProfileName: { Type: "String" },
      RouteReady: { Type: "String" },
      AssociationReady: { Type: "String" },
    },
    Resources: {
      Instance: {
        Type: "AWS::EC2::Instance",
        Properties: {
          ImageId: { Ref: "ImageId" },
          InstanceType: config.instanceType,
          SubnetId: { Ref: "SubnetId" },
          SecurityGroupIds: [{ Ref: "SecurityGroupId" }],
          KeyName: { Ref: "KeyName" },
          IamInstanceProfile: { Ref: "InstanceProfileName" },
          HibernationOptions: { Configured: true },
          BlockDeviceMappings: [
            {
              DeviceName: "/dev/sda1",
              Ebs: {
                VolumeType: "gp3",
                VolumeSize: config.diskGb,
                Encrypted: true,
                DeleteOnTermination: true,
              },
            },
          ],
          MetadataOptions: {
            HttpEndpoint: "enabled",
            HttpTokens: "required",
            HttpPutResponseHopLimit: 1,
          },
          UserData: { "Fn::Base64": userData },
          Tags: [
            { Key: "Name", Value: `cloudbox-${config.name}` },
            { Key: "cloudbox", Value: config.name },
            { Key: "cloudbox-route", Value: { Ref: "RouteReady" } },
            { Key: "cloudbox-route-association", Value: { Ref: "AssociationReady" } },
          ],
        },
      },
    },
    Outputs: {
      InstanceId: { Value: { Ref: "Instance" } },
      PublicIp: { Value: { "Fn::GetAtt": ["Instance", "PublicIp"] } },
    },
  });

const deployAws = (config: AwsCloudboxConfig, sshPublicKey: string, userData: string) =>
  Effect.gen(function* () {
    const actualRegion = yield* AWSRegion.CurrentRegion;
    yield* Schema.decodeUnknownEffect(Schema.Literal(config.region))(actualRegion).pipe(
      Effect.mapError((cause) => new Config.ConfigError(cause)),
    );
    const vpc = yield* AWS.EC2.Vpc("CloudboxVpc", {
      cidrBlock: "10.42.0.0/16",
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: { cloudbox: config.name },
    });
    const gateway = yield* AWS.EC2.InternetGateway("CloudboxInternetGateway", {
      vpcId: vpc.vpcId,
      tags: { cloudbox: config.name },
    });
    const subnet = yield* AWS.EC2.Subnet("CloudboxPublicSubnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.42.0.0/24",
      mapPublicIpOnLaunch: true,
      tags: { cloudbox: config.name },
    });
    const routeTable = yield* AWS.EC2.RouteTable("CloudboxPublicRoutes", {
      vpcId: vpc.vpcId,
      tags: { cloudbox: config.name },
    });
    const route = yield* AWS.EC2.Route("CloudboxInternetRoute", {
      routeTableId: routeTable.routeTableId,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: gateway.internetGatewayId,
    });
    const routeAssociation = yield* AWS.EC2.RouteTableAssociation(
      "CloudboxPublicRouteAssociation",
      { routeTableId: routeTable.routeTableId, subnetId: subnet.subnetId },
    );
    const keyPair = yield* AWS.EC2.KeyPair("CloudboxKeyPair", {
      publicKeyMaterial: sshPublicKey.trim(),
      keyType: "ed25519",
      tags: { cloudbox: config.name },
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("CloudboxSecurityGroup", {
      vpcId: vpc.vpcId,
      description: `SSH access for cloudbox ${config.name}`,
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIpv4: config.sshCidr,
          description: "SSH from configured CIDR only",
        },
      ],
      egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0", description: "Allow all outbound traffic" }],
      tags: { cloudbox: config.name },
    });
    const role = yield* AWS.IAM.Role("CloudboxInstanceRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: ["sts:AssumeRole"] }],
      },
      inlinePolicies: {
        HibernateTaggedCloudbox: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["ec2:StopInstances", "ec2:DescribeInstances"],
              Resource: "*",
              Condition: { StringEquals: { "aws:ResourceTag/cloudbox": config.name } },
            },
          ],
        },
      },
      tags: { cloudbox: config.name },
    });
    const profile = yield* AWS.IAM.InstanceProfile("CloudboxInstanceProfile", {
      roleName: role.roleName,
      tags: { cloudbox: config.name },
    });
    const instance = yield* AWS.CloudFormation.Stack("CloudboxInstance", {
      templateBody: makeInstanceTemplate(config, userData),
      parameters: {
        SubnetId: subnet.subnetId,
        SecurityGroupId: securityGroup.groupId,
        KeyName: keyPair.keyName,
        InstanceProfileName: profile.instanceProfileName,
        RouteReady: route.routeTableId,
        AssociationReady: routeAssociation.associationId,
      },
      tags: { cloudbox: config.name },
    });
    return {
      instanceId: instance.outputs.InstanceId,
      publicIp: instance.outputs.PublicIp,
      region: config.region,
    };
  });

const deployGcp = (
  config: GcpCloudboxConfig,
  sshPublicKey: string,
  hostBootstrap: string,
  idleBundle: string,
  machinesBundle: string,
  wakeBundle: string,
) =>
  Effect.gen(function* () {
    const instanceName = `cloudbox-${config.name}`;
    const dataDiskName = gcpDataDiskName(config);
    const wakeServiceName = gcpWakeServiceName(config);
    const networkTag = instanceName;
    const region = gcpRegion(config.gcp.zone);
    const apiNames = [
      "run.googleapis.com",
      "cloudbuild.googleapis.com",
      "artifactregistry.googleapis.com",
      "secretmanager.googleapis.com",
      "storage.googleapis.com",
    ] as const;
    const apis = yield* Effect.all(
      apiNames.map((service) =>
        GCP.GcpProjectService(`CloudboxApi-${service.split(".")[0]}`, {
          project: config.gcp.project,
          service,
        }),
      ),
    );
    const api = Object.fromEntries(apiNames.map((name, index) => [name, apis[index]!.serviceName]));
    const projectInfo = yield* GCP.GcpProjectInfo("CloudboxProjectInfo", {
      project: config.gcp.project,
    });
    const projectNumber = projectInfo.projectNumber;
    yield* GCP.GcpFirewallRule("CloudboxSshFirewall", {
      project: config.gcp.project,
      name: `${instanceName}-ssh`,
      sshCidr: config.sshCidr,
      targetTag: networkTag,
      cloudboxName: config.name,
    });
    const disk = yield* GCP.GcpDisk("CloudboxDataDisk", {
      project: config.gcp.project,
      zone: config.gcp.zone,
      name: dataDiskName,
      sizeGb: config.gcp.dataDiskGb,
      type: config.gcp.dataDiskType,
      cloudboxName: config.name,
    });
    const assetsBucketName = gcpBucketName(config, "assets");
    const assetsBucket = yield* GCP.GcpStorageBucket("CloudboxHostAssetsBucket", {
      project: config.gcp.project,
      name: assetsBucketName,
      location: region,
      cloudboxName: config.name,
      apiService: api["storage.googleapis.com"]!,
    });
    const bootstrapSha256 = sha256(hostBootstrap);
    const idleSha256 = sha256(idleBundle);
    const machinesSha256 = sha256(machinesBundle);
    const [bootstrapObject, idleObject, machinesObject] = yield* Effect.all([
      GCP.GcpStorageObject("CloudboxHostBootstrapObject", {
        bucketName: assetsBucket.bucketName,
        objectName: bootstrapSha256,
        contentBase64: Buffer.from(hostBootstrap, "utf8").toString("base64"),
        contentType: "text/x-shellscript; charset=utf-8",
        sha256: bootstrapSha256,
        apiService: api["storage.googleapis.com"]!,
      }),
      GCP.GcpStorageObject("CloudboxIdleBundleObject", {
        bucketName: assetsBucket.bucketName,
        objectName: idleSha256,
        contentBase64: Buffer.from(idleBundle, "utf8").toString("base64"),
        contentType: "text/javascript; charset=utf-8",
        sha256: idleSha256,
        apiService: api["storage.googleapis.com"]!,
      }),
      GCP.GcpStorageObject("CloudboxMachinesBundleObject", {
        bucketName: assetsBucket.bucketName,
        objectName: machinesSha256,
        contentBase64: Buffer.from(machinesBundle, "utf8").toString("base64"),
        contentType: "text/javascript; charset=utf-8",
        sha256: machinesSha256,
        apiService: api["storage.googleapis.com"]!,
      }),
    ]);
    const computeServiceAccountEmail = GCP.cloudBuildServiceAccountEmail(projectNumber);
    const computeMember = GCP.iamServiceAccountMember(computeServiceAccountEmail);
    const assetsBinding = yield* GCP.GcpResourceIamBinding("CloudboxHostAssetsIam", {
      target: "bucket",
      resourceName: assetsBucket.bucketName,
      member: computeMember,
      role: "roles/storage.objectViewer",
      apiService: api["storage.googleapis.com"]!,
    });
    const startupScript = renderFetchWrapper({
      bucketName: assetsBucketName,
      bootstrap: {
        objectName: bootstrapSha256,
        sha256: bootstrapSha256,
        destination: "/var/lib/cloudbox/host-bootstrap.sh",
        mode: "700",
      },
      idle: {
        objectName: idleSha256,
        sha256: idleSha256,
        destination: "/opt/cloudbox/idle.mjs",
        mode: "755",
      },
      machines: {
        objectName: machinesSha256,
        sha256: machinesSha256,
        destination: "/opt/cloudbox/machines.mjs",
        mode: "755",
      },
    });
    if (Buffer.byteLength(startupScript, "utf8") >= 4 * 1024) {
      return yield* Effect.die("Rendered GCE fetch wrapper is not smaller than 4 KiB");
    }
    const instance = yield* GCP.GcpInstance("CloudboxInstance", {
      project: config.gcp.project,
      zone: config.gcp.zone,
      name: instanceName,
      machineType: config.gcp.machineType,
      bootDiskGb: config.gcp.bootDiskGb,
      dataDiskName: disk.dataDiskName,
      networkTag,
      startupScript,
      sshPublicKey: sshPublicKey.trim(),
      cloudboxName: config.name,
      assetDependencies: [
        bootstrapObject.objectName,
        idleObject.objectName,
        machinesObject.objectName,
        assetsBinding.role,
      ],
    });
    const wakeServiceAccount = yield* GCP.GcpServiceAccount("CloudboxWakeServiceAccount", {
      project: config.gcp.project,
      accountId: "cloudbox-wake",
      cloudboxName: config.name,
    });
    const wakeRole = yield* GCP.GcpCustomRole("CloudboxWakeRole", {
      project: config.gcp.project,
      roleId: "cloudboxWake",
      cloudboxName: config.name,
    });
    const wakeBinding = yield* GCP.GcpIamBinding("CloudboxWakeIamBinding", {
      project: config.gcp.project,
      zone: config.gcp.zone,
      instanceName: instance.instanceName,
      cloudboxName: config.name,
      serviceAccountEmail: wakeServiceAccount.email,
      roleName: wakeRole.name,
    });
    const archive = GCP.makeWakeSourceArchive(wakeBundle);
    const sourceBucket = yield* GCP.GcpStorageBucket("CloudboxWakeSourceBucket", {
      project: config.gcp.project,
      name: gcpBucketName(config, "source"),
      location: region,
      cloudboxName: config.name,
      apiService: api["storage.googleapis.com"]!,
    });
    const sourceObject = yield* GCP.GcpStorageObject("CloudboxWakeSourceObject", {
      bucketName: sourceBucket.bucketName,
      objectName: `wake-${archive.sha256}.tar.gz`,
      contentBase64: archive.bytes.toString("base64"),
      contentType: "application/gzip",
      sha256: archive.sha256,
      apiService: api["storage.googleapis.com"]!,
    });
    const rateBucket = yield* GCP.GcpStorageBucket("CloudboxWakeRateBucket", {
      project: config.gcp.project,
      name: gcpBucketName(config, "rate"),
      location: region,
      cloudboxName: config.name,
      apiService: api["storage.googleapis.com"]!,
    });
    const repository = yield* GCP.GcpArtifactRepository("CloudboxWakeRepository", {
      project: config.gcp.project,
      location: region,
      repositoryId: "cloudbox-wake",
      cloudboxName: config.name,
      apiService: api["artifactregistry.googleapis.com"]!,
    });
    const imageUri = `${region}-docker.pkg.dev/${config.gcp.project}/cloudbox-wake/service:${archive.sha256}`;
    const buildMember = computeMember;
    const buildProjectBinding = yield* GCP.GcpResourceIamBinding("CloudboxWakeBuildProjectIam", {
      target: "project",
      resourceName: `projects/${config.gcp.project}`,
      member: buildMember,
      role: "roles/cloudbuild.builds.builder",
      apiService: api["cloudbuild.googleapis.com"]!,
    });
    const buildSourceBinding = yield* GCP.GcpResourceIamBinding("CloudboxWakeBuildSourceIam", {
      target: "bucket",
      resourceName: sourceBucket.bucketName,
      member: buildMember,
      role: "roles/storage.objectViewer",
      apiService: api["storage.googleapis.com"]!,
    });
    const buildRepositoryBinding = yield* GCP.GcpResourceIamBinding("CloudboxWakeBuildRepositoryIam", {
      target: "artifactRepository",
      resourceName: repository.name,
      member: buildMember,
      role: "roles/artifactregistry.writer",
      apiService: api["artifactregistry.googleapis.com"]!,
    });
    const build = yield* GCP.GcpCloudBuild("CloudboxWakeBuild", {
      project: config.gcp.project,
      location: region,
      bucketName: sourceObject.bucketName,
      objectName: sourceObject.objectName,
      imageUri,
      sourceSha256: archive.sha256,
      dependencies: [
        api["cloudbuild.googleapis.com"]!,
        api["artifactregistry.googleapis.com"]!,
        buildProjectBinding.role,
        buildSourceBinding.role,
        buildRepositoryBinding.role,
      ],
    });
    const wakeSecret = yield* Alchemy.makeRandom("CloudboxWakeBearerSecret", { bytes: 32 });
    const secret = yield* GCP.GcpSecret("CloudboxWakeSecret", {
      project: config.gcp.project,
      secretId: wakeServiceName,
      cloudboxName: config.name,
      apiService: api["secretmanager.googleapis.com"]!,
    });
    const secretVersion = yield* GCP.GcpSecretVersion("CloudboxWakeSecretVersion", {
      secretName: secret.name,
      value: wakeSecret,
      apiService: api["secretmanager.googleapis.com"]!,
    });
    const wakeMember = GCP.iamServiceAccountMember(wakeServiceAccount.email);
    const rateBucketBinding = yield* GCP.GcpResourceIamBinding("CloudboxWakeRateBucketIam", {
      target: "bucket",
      resourceName: rateBucket.bucketName,
      member: wakeMember,
      role: "roles/storage.objectAdmin",
      apiService: api["storage.googleapis.com"]!,
    });
    const secretBinding = yield* GCP.GcpResourceIamBinding("CloudboxWakeSecretIam", {
      target: "secret",
      resourceName: secret.name,
      member: wakeMember,
      role: "roles/secretmanager.secretAccessor",
      apiService: api["secretmanager.googleapis.com"]!,
    });
    const wakeService = yield* GCP.GcpCloudRunService("CloudboxWakeService", {
      project: config.gcp.project,
      location: region,
      serviceName: wakeServiceName,
      cloudboxName: config.name,
      serviceAccountEmail: wakeServiceAccount.email,
      imageUri,
      zone: config.gcp.zone,
      instanceName: instance.instanceName,
      rateLimitBucket: rateBucket.bucketName,
      secretName: secret.name,
      secretVersion: secretVersion.version,
      buildId: build.buildId,
      runtimeBindings: [wakeBinding.roleName, rateBucketBinding.role, secretBinding.role],
      apiService: api["run.googleapis.com"]!,
    });
    yield* GCP.GcpResourceIamBinding("CloudboxWakePublicInvoker", {
      target: "cloudRun",
      resourceName: wakeService.name,
      member: "allUsers",
      role: "roles/run.invoker",
      apiService: api["run.googleapis.com"]!,
    });
    return {
      instanceName: instance.instanceName,
      zone: instance.zone,
      externalIp: instance.externalIp,
      dataDiskName: disk.dataDiskName,
      wakeServiceAccount: wakeServiceAccount.email,
      wakeUrl: wakeService.uri,
      wakeSecret: wakeSecret.pipe(Output.map(Redacted.value)),
      wakeClientUrlEnv: "CLOUDBOX_WAKE_URL",
      wakeClientSecretEnv: "CLOUDBOX_WAKE_SECRET",
    };
  });

export default Alchemy.Stack(
  "Cloudbox",
  { providers: cloudProviders, state: Alchemy.localState() },
  Effect.gen(function* () {
    const config = yield* loadConfig("cloudbox.json").pipe(Effect.orDie);
    const inputs = yield* deploymentInputs(config).pipe(Effect.orDie);
    return config.provider === "aws"
      ? yield* deployAws(
          config,
          inputs.sshPublicKey,
          inputs.startupScript ?? (yield* Effect.die("AWS startup script is missing")),
        )
      : yield* deployGcp(
          config,
          inputs.sshPublicKey,
          inputs.hostBootstrap ?? (yield* Effect.die("host bootstrap is missing")),
          inputs.idleBundle ?? (yield* Effect.die("idle bundle is missing")),
          inputs.machinesBundle ?? (yield* Effect.die("machines bundle is missing")),
          inputs.wakeBundle ?? (yield* Effect.die("wake bundle is missing")),
        );
  }),
);
