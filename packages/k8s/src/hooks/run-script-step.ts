/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import { execPodStep, getPodStatus } from '../k8s'
import { fixArgs, writeEntryPointScript } from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import * as grpc from '@grpc/grpc-js';

import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path'
import { GoogleAuth } from 'google-auth-library'

const PROTO_PATH = join(__dirname, './script_executor.proto');
core.debug(`proto path is ${PROTO_PATH}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const googleAuth = new GoogleAuth();

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const scriptExecutor = protoDescriptor.script_executor;

export async function runScriptStep(
  args: RunScriptStepArgs,
  state,
  responseFile
): Promise<void> {
  const { entryPoint, entryPointArgs, environmentVariables } = args
  const { containerPath, runnerPath } = writeEntryPointScript(
    args.workingDirectory,
    entryPoint,
    entryPointArgs,
    args.prependPath,
    environmentVariables
  )

  core.debug(`quoct job pod ${state.jobPod}`)
  // pod has failed so pull the status code from the container
  const status = await getPodStatus(state.jobPod)
  if (status?.phase === 'Succeeded') {
    throw new Error(`Failed to get pod ${state.jobPod} status`);
  }
  if (status?.podIP == undefined) {
    throw new Error(`Failed to get pod ${state.jobPod} IP`);
  }

  core.debug(`pod IP is ${status?.podIP}`);
  const credentials = await googleAuth.getApplicationDefault();
  const client = new scriptExecutor.ScriptExecutor(
    `${status?.podIP}:50051`,
    grpc.credentials.createFromGoogleCredential(credentials.credential),
    {
      // Ping the server every 10 seconds to ensure the connection is still active
      'grpc.keepalive_time_ms': 10_000,
      // Wait 5 seconds for the ping ack before assuming the connection is dead
      'grpc.keepalive_timeout_ms': 5_000,
      // send pings even without active streams
      'grpc.keepalive_permit_without_calls': 1
    }
  );

  args.entryPoint = 'sh'
  args.entryPointArgs = ['-e', containerPath]
  try {
    core.debug(`quoct execing pod step ${JSON.stringify(args)}`);
    const command = fixArgs([args.entryPoint, ...args.entryPointArgs]).join(' ');
    core.debug(`about to exec command ${command}`);    

    const call = client.executeScript({script: command});
     
    await new Promise<void>(async function (resolve, reject) {
      let exitCode = -1;
      call.on('data', (response: any) => {
        if (response.hasOwnProperty('code')) {
          exitCode = response.code;
        }
        if (response.hasOwnProperty('output')) {
          console.log('quoct output: ' + response.output);
        }
        if (response.hasOwnProperty('error')) {
          console.error('quoct error: ' + response.error);
        }
      });
    
      call.on('end', async () => {
        // Half a second wait in case the data event with the exit code did not get triggered yet.
        await sleep(500);
        console.log(`Job exit code is ${exitCode}, after sleep`);
        if (exitCode == 0) {
          resolve();
        } else {
          reject(`Job failed with exit code ${exitCode}`);
        }
      });
    
      call.on('error', (err: any) => {
        console.error('quoct Error:', err);
        reject();
      });  
    });

    /*
    await execPodStep(
      [args.entryPoint, ...args.entryPointArgs],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
    */
    core.debug(`quoct done execing pod step ${JSON.stringify(args)}`);
  } catch (err) {
    core.debug(`quoct execPodStep for ${JSON.stringify(args)} failed: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to run script step: ${message}`)
  } finally {
    core.debug(`quoct getting to finally ${JSON.stringify(args)}`)
    fs.rmSync(runnerPath)
  }
}
