#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import {BlockDeviceVolume, EbsDeviceVolumeType} from '@aws-cdk/aws-ec2';
import * as s3 from '@aws-cdk/aws-s3';
import * as lambda from '@aws-cdk/aws-lambda';
import * as cr from '@aws-cdk/custom-resources';
import * as logs from '@aws-cdk/aws-logs';
import * as autoscaling from '@aws-cdk/aws-autoscaling';
import * as iam from '@aws-cdk/aws-iam';
import * as path from "path";

const app = new cdk.App();

const env = {
  region: app.node.tryGetContext('region') || process.env.CDK_INTEG_REGION || process.env.CDK_DEFAULT_REGION,
  account: app.node.tryGetContext('account') || process.env.CDK_INTEG_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT
};

const stack = new cdk.Stack(app, 'k3sCluster', { env })

// VPC for all k3s resources
const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 3, natGateways: 0 });

// S3 bucket to host K3s token + kubeconfig file
const k3sBucket = new s3.Bucket(stack, 'k3sBucket', {
  removalPolicy: cdk.RemovalPolicy.DESTROY, // when we delete the cluster, delete all tokens with it
});

// We want to call a lambda (custom-resource-handler/index.py) on s3 delete action (to clear all files so delete succeeds)
const onEvent = new lambda.Function(stack, 'onEventHandler', {
  runtime: lambda.Runtime.PYTHON_3_8,
  code: lambda.Code.fromAsset(path.join(__dirname, '../custom-resource-handler')),
  handler: 'index.on_event',
});

const deleteS3ObjectProvider = new cr.Provider(stack, 'deleteS3ObjectProvider', {
  onEventHandler: onEvent,
  logRetention: logs.RetentionDays.ONE_DAY,
});

const CRdeleteS3ObjectProvider = new cdk.CustomResource(stack, 'CRdeleteS3ObjectProvider', {
  serviceToken: deleteS3ObjectProvider.serviceToken,
  properties: {
    Bucket: k3sBucket.bucketName,
  },
});

CRdeleteS3ObjectProvider.node.addDependency(k3sBucket);
k3sBucket.grantDelete(onEvent);
k3sBucket.grantReadWrite(onEvent);

// Setup network security
// control plane node Security Group
const masterSG = new ec2.SecurityGroup(stack, 'master-sg', { vpc });
masterSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), 'Allow for any traffic');

// worker nodes Security Group
const k3sworkersg = new ec2.SecurityGroup(stack, 'worker-sg', { vpc });
k3sworkersg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), 'Allow for any traffic');

// get AL2 arm64 AMI
const ami = ec2.MachineImage.latestAmazonLinux({
  cpuType: ec2.AmazonLinuxCpuType.ARM_64,
  generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
});

const instanceType = ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO)

// setup k3s master
const k3scontrolplane = new ec2.Instance(stack, 'master-ec2', {
  instanceType: instanceType,
  machineImage: ami,
  blockDevices: [
    {
      deviceName: "/dev/xvda",
      mappingEnabled: true,
      volume: BlockDeviceVolume.ebs(8, {
        volumeType: EbsDeviceVolumeType.GP3
      })
    }
  ],
  vpc,
  vpcSubnets: {
    subnets: vpc.publicSubnets,
  },
  instanceName: 'master',
  securityGroup: masterSG,
});
k3scontrolplane.addUserData(`
       #!/bin/bash
       curl -L -o k3s https://github.com/k3s-io/k3s/releases/download/v1.21.5%2Bk3s2/k3s-arm64
       chmod +x k3s
       ./k3s server &
       sleep 30
       ENDPOINT=$(curl http://169.254.169.254/latest/meta-data/public-hostname) 
       cp /etc/rancher/k3s/k3s.yaml /etc/rancher/k3s/k3s.yaml
       sed -i s/127.0.0.1/$ENDPOINT/ /etc/rancher/k3s/k3s.yaml
       aws s3 cp /var/lib/rancher/k3s/server/node-token s3://${k3sBucket.bucketName}/node-token
       aws s3 cp /etc/rancher/k3s/k3s.yaml s3://${k3sBucket.bucketName}/k3s.yaml
     `);

// Setup worker ASG

// create launch template for worker ASG
// prepare the userData
const userData = ec2.UserData.forLinux();
userData.addCommands(`
          #!/bin/bash
          LOGFILE='/var/log/k3s.log'
          curl -L -o k3s https://github.com/k3s-io/k3s/releases/download/v1.21.5%2Bk3s2/k3s-arm64
          chmod +x k3s
          echo the bucket name is ${k3sBucket.bucketName} 
          aws s3 cp s3://${k3sBucket.bucketName}/node-token /node-token 
          (./k3s agent --server https://${k3scontrolplane.instancePrivateIp}:6443 \
          --token $(cat /node-token) 2>&1 | tee -a $LOGFILE || echo "failed" > $LOGFILE &)
    `);

// create worker ASG
const workerAsg = new autoscaling.AutoScalingGroup(stack, 'WorkerAsg', {
  instanceType: instanceType,
  machineImage: ami,
  vpc,
  vpcSubnets: {
    subnetType: ec2.SubnetType.PUBLIC,
  },
  minCapacity: 3,
});

const cfnInstanceProfile = workerAsg.node.tryFindChild('InstanceProfile') as iam.CfnInstanceProfile;

const lt = new ec2.CfnLaunchTemplate(stack, 'WorkerLaunchTemplate', {
  launchTemplateData: {
    imageId: ami.getImage(stack).imageId,
    instanceType: instanceType.toString(),
    blockDeviceMappings: [
      {
        deviceName: "/dev/xvda",
        noDevice: "/dev/xvda",
        ebs: {
          deleteOnTermination: true,
          volumeSize: 8,
          volumeType: "gp3"
        }
      }
    ],
    instanceMarketOptions: {
      marketType: 'spot',
      spotOptions: {
        spotInstanceType: 'one-time',
      },
    },
    userData: cdk.Fn.base64(userData.render()),
    iamInstanceProfile: {
      arn: cfnInstanceProfile.attrArn,
    },
    securityGroupIds: [k3sworkersg.securityGroupId],
  },
});

// Force overwrite launch template
const cfnAsg = workerAsg.node.tryFindChild('ASG');
// @ts-ignore
cfnAsg.addPropertyDeletionOverride('LaunchConfigurationName');
// @ts-ignore
cfnAsg.addPropertyOverride('LaunchTemplate', {
  LaunchTemplateId: lt.ref,
  Version: lt.attrLatestVersionNumber,
});
workerAsg.addSecurityGroup(k3sworkersg);
// enable the SSM session manager
workerAsg.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
// grant the S3 write permission to the control plane node and read permissions to the worker nodes
k3sBucket.grantWrite(k3scontrolplane.role);
k3sBucket.grantRead(workerAsg.role);
// endpoint info
new cdk.CfnOutput(stack, 'Endpoint', { value: `https://${k3scontrolplane.instancePublicIp}:6443` });
// kubeconfig.yaml path
new cdk.CfnOutput(stack, 'Kubernetes configuration file', { value: `s3://${k3sBucket.bucketName}/k3s.yaml` });
workerAsg.node.addDependency(k3scontrolplane);
