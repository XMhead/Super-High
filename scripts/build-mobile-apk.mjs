import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const localAppData = process.env.LOCALAPPDATA

if (!localAppData) {
  throw new Error('LOCALAPPDATA is not set')
}

const javaHome = join(localAppData, 'Programs', 'SuperHighAndroidEnv', 'jdk-21')
const androidHome = join(localAppData, 'Android', 'Sdk')
const javaExe = join(javaHome, 'bin', 'java.exe')
const androidDir = join(process.cwd(), 'android')
const gradlew = join(androidDir, 'gradlew.bat')

if (!existsSync(javaExe)) {
  throw new Error(`JDK 21 is missing: ${javaExe}`)
}
if (!existsSync(join(androidHome, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat'))) {
  throw new Error(`Android SDK command-line tools are missing: ${androidHome}`)
}
if (!existsSync(gradlew)) {
  throw new Error(`Gradle wrapper is missing: ${gradlew}`)
}

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  Path: [
    join(javaHome, 'bin'),
    join(androidHome, 'cmdline-tools', 'latest', 'bin'),
    join(androidHome, 'platform-tools'),
    process.env.Path ?? process.env.PATH ?? '',
  ].join(';'),
}

run(process.platform === 'win32' ? 'npm run mobile:sync' : 'npm run mobile:sync', { cwd: process.cwd(), env })
run(process.platform === 'win32' ? '.\\gradlew.bat assembleDebug' : './gradlew assembleDebug', { cwd: androidDir, env })

function run(commandLine, options) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', commandLine], {
      ...options,
      stdio: 'inherit',
    })
    : spawnSync(commandLine, {
      ...options,
      shell: true,
      stdio: 'inherit',
    })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
