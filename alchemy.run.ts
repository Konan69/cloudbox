// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as AWSRegion from "alchemy/AWS/Region";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { renderHostStartupScript } from "./src/bootstrap/render-host.ts";
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
    const startupScript =
      config.provider === "aws"
        ? renderUserData({
            config,
            sshPublicKey,
            idleBundle: yield* readInput("dist/idle-aws.mjs", "pnpm build:idle:aws"),
          })
        : renderHostStartupScript({
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
            idleBundle: yield* readInput("dist/idle.mjs", "pnpm build:idle"),
            machinesBundle: yield* readInput("dist/machines.mjs", "pnpm build:machines"),
          });
    const limit = config.provider === "aws" ? 16 * 1024 : 256 * 1024;
    if (Buffer.byteLength(startupScript, "utf8") > limit) {
      return yield* Effect.fail(
        new DeploymentInputError({
          message: `Rendered ${config.provider === "aws" ? "EC2 user data" : "GCE startup script"} exceeds the ${config.provider === "aws" ? "16 KiB" : "256 KiB"} launch limit`,
        }),
      );
    }
    return { sshPublicKey, startupScript };
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

const cloudflareProviders = Layer.unwrap(
  loadConfig("cloudbox.json").pipe(
    Effect.map((config) =>
      config.provider === "gcp" ? Cloudflare.providers() : Layer.empty,
    ),
    Effect.orDie,
  ),
);

const cloudProviders = Layer.mergeAll(awsProviders, gcpProviders, cloudflareProviders);

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

const deployGcp = (config: GcpCloudboxConfig, sshPublicKey: string, startupScript: string) =>
  Effect.gen(function* () {
    const instanceName = `cloudbox-${config.name}`;
    const dataDiskName = gcpDataDiskName(config);
    const networkTag = instanceName;
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
    const wakeKey = yield* GCP.GcpServiceAccountKey("CloudboxWakeServiceAccountKey", {
      project: config.gcp.project,
      serviceAccountEmail: wakeServiceAccount.email,
      rotation: config.gcp.wakeKeyRotation,
    });
    const wakeSecret = yield* Alchemy.makeRandom("CloudboxWakeBearerSecret", { bytes: 32 });
    const wakeRateLimit = yield* Cloudflare.KV.Namespace("CloudboxWakeRateLimit", {
      title: `cloudbox-${config.name}-wake-rate-limit`,
    });
    const wakeWorker = yield* Cloudflare.Worker("CloudboxWakeWorker", {
      main: "./src/wake/worker.ts",
      compatibility: { date: "2026-08-28" },
      env: {
        GCP_PROJECT: config.gcp.project,
        GCP_ZONE: config.gcp.zone,
        GCE_INSTANCE: instance.instanceName,
        CLOUDBOX_NAME: config.name,
        GCP_SERVICE_ACCOUNT_KEY: wakeKey.privateKeyJson,
        WAKE_SECRET: wakeSecret,
        WAKE_RATE_LIMIT: wakeRateLimit,
        GCP_ROLE_NAME: wakeBinding.roleName,
      },
    });
    return {
      instanceName: instance.instanceName,
      zone: instance.zone,
      externalIp: instance.externalIp,
      dataDiskName: disk.dataDiskName,
      wakeServiceAccount: wakeServiceAccount.email,
      wakeServiceAccountKey: wakeKey.name,
      wakeUrl: wakeWorker.url,
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
    const { sshPublicKey, startupScript } = yield* deploymentInputs(config).pipe(Effect.orDie);
    return config.provider === "aws"
      ? yield* deployAws(config, sshPublicKey, startupScript)
      : yield* deployGcp(config, sshPublicKey, startupScript);
  }),
);
