import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.superhigh.mobile',
  appName: 'Super High',
  webDir: 'dist-mobile',
  server: {
    cleartext: true,
    androidScheme: 'http',
    allowNavigation: ['*'],
  },
}

export default config
