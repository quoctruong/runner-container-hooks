/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import { execPodStep } from '../k8s'
import { fixArgs, writeEntryPointScript } from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_PATH = './script_executor.proto';

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

  args.entryPoint = 'sh'
  args.entryPointArgs = ['-e', containerPath]
  try {
    core.debug(`quoct execing pod step ${JSON.stringify(args)}`);
    const command = fixArgs([args.entryPoint, ...args.entryPointArgs]);
    core.debug(`about to exec command ${command}`);
    // MAKE THIS CLIENT REUSABLE.
    const client = new scriptExecutor.ScriptExecutor(
      'grpc-service:50051',
      grpc.credentials.createInsecure(),
    );
    
    core.debug(`quoct established client. Time to execute script.`);
    const call = client.executeScript({command});
  
    call.on('data', (response: any) => {
      console.log('quoct Output:', response.output);
    });
  
    call.on('end', () => {
      console.log('quoct Stream ended');
    });
  
    call.on('error', (err: any) => {
      console.error('quoct Error:', err);
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
