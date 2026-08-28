// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as AWSRegion from "alchemy/AWS/Region";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { renderUserData } from "./src/bootstrap/render.ts";
import { loadConfig } from "./src/config.ts";

class DeploymentInputError extends Data.TaggedError("DeploymentInputError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), path.slice(2))
    : NodePath.resolve(path);

const deploymentInputs = Effect.gen(function* () {
  const config = yield* loadConfig("cloudbox.json");
  const fs = yield* FileSystem.FileSystem;
  const sshPublicKey = yield* fs.readFileString(expandHome(config.sshPublicKeyPath)).pipe(
    Effect.mapError(
      (cause) =>
        new DeploymentInputError({
          message: `Cannot read sshPublicKeyPath ${config.sshPublicKeyPath}`,
          cause,
        }),
    ),
  );
  const idleBundle = yield* fs.readFileString("dist/idle.mjs").pipe(
    Effect.mapError(
      (cause) =>
        new DeploymentInputError({
          message: "dist/idle.mjs is required; run pnpm build:idle",
          cause,
        }),
    ),
  );
  const githubToken = yield* Effect.sync(() => process.env[config.t3.githubTokenEnv]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.NonEmptyString)),
    Effect.mapError(
      (cause) =>
        new DeploymentInputError({
          message: `Required environment variable ${config.t3.githubTokenEnv} is missing or empty`,
          cause,
        }),
    ),
  );
  const userData = renderUserData({ config, sshPublicKey, githubToken, idleBundle });
  if (Buffer.byteLength(userData, "utf8") > 16 * 1024) {
    return yield* Effect.fail(
      new DeploymentInputError({
        message: "Rendered EC2 user data exceeds the 16 KiB launch limit",
      }),
    );
  }
  return { config, sshPublicKey, userData };
}).pipe(Effect.provide(NodeServices.layer));

const { config, sshPublicKey, userData } = await Effect.runPromise(deploymentInputs);

const instanceTemplate = JSON.stringify({
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

export default Alchemy.Stack(
  "Cloudbox",
  {
    providers: Layer.mergeAll(AWS.providers(), AWSRegion.of(config.region)),
    state: Alchemy.localState(),
  },
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
      {
        routeTableId: routeTable.routeTableId,
        subnetId: subnet.subnetId,
      },
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
      egress: [
        {
          ipProtocol: "-1",
          cidrIpv4: "0.0.0.0/0",
          description: "Allow all outbound traffic",
        },
      ],
      tags: { cloudbox: config.name },
    });

    const role = yield* AWS.IAM.Role("CloudboxInstanceRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        HibernateTaggedCloudbox: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["ec2:StopInstances", "ec2:DescribeInstances"],
              Resource: "*",
              Condition: {
                StringEquals: { "ec2:ResourceTag/cloudbox": config.name },
              },
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
      templateBody: instanceTemplate,
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
  }),
);
