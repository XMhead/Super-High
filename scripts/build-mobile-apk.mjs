import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const localAppData = process.env.LOCALAPPDATA
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: node scripts/build-mobile-apk.mjs [--native-only | --compile-only]\nSUPERHIGH_ANDROID_GRADLE may point to an existing Gradle executable for a local build; otherwise the project wrapper is used. SUPERHIGH_ANDROID_MAVEN_CENTRAL and SUPERHIGH_ANDROID_GOOGLE_MAVEN override those repositories only for this build. --native-only reuses already synced web assets; --compile-only checks native Java without building an APK.')
  process.exit(0)
}
if (args.some(arg => arg !== '--native-only' && arg !== '--compile-only') || args.length > 1) throw new Error('Unknown argument; see --help')

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

run('node scripts/sync-android-cli-icons.mjs', { cwd: process.cwd(), env })
if (!args.includes('--native-only') && !args.includes('--compile-only')) run('npm run mobile:sync', { cwd: process.cwd(), env })
const gradleOverride = process.env.SUPERHIGH_ANDROID_GRADLE
if (gradleOverride && !existsSync(gradleOverride)) throw new Error('SUPERHIGH_ANDROID_GRADLE does not exist')
const gradleCommand = gradleOverride ? `"${gradleOverride}"` : process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew'
const repositoryOverride = process.env.SUPERHIGH_ANDROID_MAVEN_CENTRAL
const googleOverride = process.env.SUPERHIGH_ANDROID_GOOGLE_MAVEN
for (const url of [repositoryOverride, googleOverride]) {
  if (url && new URL(url).protocol !== 'https:') throw new Error('Maven override requires HTTPS')
}
const initScript = repositoryOverride || googleOverride ? ` --init-script "${join(process.cwd(), 'scripts/android-repository-override.gradle')}"` : ''
run(`${gradleCommand} ${args.includes('--compile-only') ? 'compileDebugJavaWithJavac' : 'assembleDebug'} --no-daemon -Pkotlin.compiler.execution.strategy=in-process${initScript}`, { cwd: androidDir, env })

function run(commandLine, options) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      ...options,
      windowsVerbatimArguments: true,
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
