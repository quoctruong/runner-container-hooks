import * as core from '@actions/core'
import { Command, getInputFromStdin, prepareJobArgs } from 'hooklib'
import {inspect} from "util"
import {
  cleanupJob,
  prepareJob,
  runContainerStep,
  runScriptStep
} from './hooks'
import { isAuthPermissionsOK, namespace, requiredPermissions } from './k8s'

async function run(): Promise<void> {
  try {
    const input = await getInputFromStdin()

    const args = input['args']
    const command = input['command']
    const responseFile = input['responseFile']
    const state = input['state']
    if (!(await isAuthPermissionsOK())) {
      throw new Error(
        `The Service account needs the following permissions ${JSON.stringify(
          requiredPermissions
        )} on the pod resource in the '${namespace()}' namespace. Please contact your self hosted runner administrator.`
      )
    }

    core.debug(`quoct running command ${command}`)
    core.debug(`quoct response file is ${responseFile}`)
    let exitCode = 0
    switch (command) {
      case Command.PrepareJob:
        await prepareJob(args as prepareJobArgs, responseFile)
        return process.exit(0)
      case Command.CleanupJob:
        await cleanupJob()
        return process.exit(0)
      case Command.RunScriptStep:
        await runScriptStep(args, state, null)
        return process.exit(0)
      case Command.RunContainerStep:
        exitCode = await runContainerStep(args)
        return process.exit(exitCode)
      default:
        throw new Error(`Command not recognized: ${command}`)
    }
  } catch (error) {
    core.debug(`quoct error ${inspect(error)} with command`)
    core.error(error as Error)
    process.exit(1)
  } finally {
    core.debug(`quoct finally in index.ts`)
  }
}

void run()
