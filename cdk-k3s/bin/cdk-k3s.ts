#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as k3s from 'cdk-k3s-cluster';

const app = new cdk.App();

const env = {
  region: app.node.tryGetContext('region') || process.env.CDK_INTEG_REGION || process.env.CDK_DEFAULT_REGION,
  account: app.node.tryGetContext('account') || process.env.CDK_INTEG_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT
};

const stack = new cdk.Stack(app, 'k8sCluster', { env })

new k3s.Cluster(stack, 'Cluster', {
  vpc: k3s.VpcProvider.getOrCreate(stack),
  spotWorkerNodes: true,
  workerMinCapacity: 3,
  workerInstanceType: new ec2.InstanceType('t4g.micro'),
  controlPlaneInstanceType: new ec2.InstanceType('t4g.micro'),
  bucketRemovalPolicy: cdk.RemovalPolicy.DESTROY
})
