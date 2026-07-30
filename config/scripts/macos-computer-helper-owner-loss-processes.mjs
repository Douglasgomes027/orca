import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const PROCESS_EXIT_TIMEOUT_MS = 2_000
const PROCESS_POLL_MS = 25
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function processIdentity(pid) {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pgid=,command='], {
      encoding: 'utf8'
    }).trim()
    const match = output.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) {
      return null
    }
    return { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }
  } catch {
    return null
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds)
}

function validateDetachedIdentity(identity, expectedCommandFragment) {
  if (
    !Number.isInteger(identity?.pid) ||
    identity.pid <= 0 ||
    identity.pgid !== identity.pid ||
    typeof identity.command !== 'string' ||
    !identity.command.includes(expectedCommandFragment)
  ) {
    throw new Error('Recorded benchmark helper identity is invalid')
  }
}

function sameIdentity(left, right) {
  return left?.pid === right?.pid && left?.pgid === right?.pgid && left?.command === right?.command
}

function processIdentities(includeEnvironment = false) {
  const args = includeEnvironment
    ? ['eww', '-axo', 'pid=,pgid=,command=']
    : ['-axo', 'pid=,pgid=,command=']
  const output = execFileSync('ps', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      command: match[3]
    }))
}

function waitForIdentityExit(identity) {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!processIdentityIsCurrent(identity)) {
      return true
    }
    sleepSync(PROCESS_POLL_MS)
  }
  throw new Error(`Recorded benchmark helper ${identity.pid} did not exit`)
}

export function spawnBenchmarkProcess(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    detached: true,
    killSignal: 'SIGKILL'
  })
}

export function signalValidatedProcessGroup(pgid, environmentFragment, signal) {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return false
  }
  const members = processIdentities(true).filter((identity) => identity.pgid === pgid)
  if (members.length === 0) {
    return false
  }
  if (members.some((identity) => !identity.command.includes(environmentFragment))) {
    throw new Error('Benchmark process group no longer belongs to this trial')
  }
  const anchor = members[0]
  try {
    process.kill(anchor.pid, 'SIGSTOP')
    const stoppedAnchor = processIdentities(true).find((identity) => identity.pid === anchor.pid)
    if (!sameIdentity(stoppedAnchor, anchor)) {
      process.kill(anchor.pid, 'SIGCONT')
      throw new Error('Benchmark process group anchor changed before signaling')
    }
    process.kill(-pgid, 'SIGSTOP')
    const stoppedMembers = processIdentities(true).filter((identity) => identity.pgid === pgid)
    if (
      stoppedMembers.length === 0 ||
      stoppedMembers.some((identity) => !identity.command.includes(environmentFragment))
    ) {
      process.kill(-pgid, 'SIGCONT')
      throw new Error('Benchmark process group changed before signaling')
    }
    if (signal !== 'SIGSTOP') {
      process.kill(-pgid, signal)
    }
    return true
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error
    }
    return false
  }
}

export function writeProcessRecord(recordPath, processIdentity) {
  const temporaryPath = `${recordPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(processIdentity))
  renameSync(temporaryPath, recordPath)
}

export function processIdentityIsCurrent(identity) {
  return sameIdentity(processIdentity(identity?.pid), identity)
}

export function signalProcessIdentity(identity, expectedCommandFragment, signal) {
  validateDetachedIdentity(identity, expectedCommandFragment)
  const currentIdentity = processIdentity(identity.pid)
  if (!currentIdentity) {
    return false
  }
  if (!sameIdentity(currentIdentity, identity)) {
    throw new Error('Recorded benchmark helper PID now belongs to another process')
  }
  try {
    process.kill(identity.pid, 'SIGSTOP')
    const stoppedIdentity = processIdentity(identity.pid)
    if (!sameIdentity(stoppedIdentity, identity)) {
      process.kill(identity.pid, 'SIGCONT')
      throw new Error('Recorded benchmark helper PID changed before signaling')
    }
    process.kill(-identity.pgid, signal)
    if (signal !== 'SIGKILL') {
      process.kill(-identity.pgid, 'SIGCONT')
    }
    return true
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

export function killRecordedProcess(recordPath, expectedCommandFragment) {
  if (!existsSync(recordPath)) {
    return false
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (!signalProcessIdentity(record, expectedCommandFragment, 'SIGKILL')) {
    return false
  }
  return waitForIdentityExit(record)
}

export function killProcessMatchingCommand(expectedCommandFragments) {
  const matches = processIdentities().filter(
    (identity) =>
      identity.pgid === identity.pid &&
      expectedCommandFragments.every((fragment) => identity.command.includes(fragment))
  )
  if (matches.length > 1) {
    throw new Error('Multiple benchmark helpers matched the trial identity')
  }
  if (matches.length === 0) {
    return false
  }
  if (!signalProcessIdentity(matches[0], expectedCommandFragments[0], 'SIGKILL')) {
    return false
  }
  return waitForIdentityExit(matches[0])
}
