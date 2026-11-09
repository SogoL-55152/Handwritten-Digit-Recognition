import { readAppConfig } from './config.js'

// Enumerate public keys so unrelated environment variables never enter the bundle.
export const appConfig = readAppConfig({
  VITE_APP_MODE: import.meta.env.VITE_APP_MODE,
  VITE_PILOT_OPERATOR: import.meta.env.VITE_PILOT_OPERATOR,
  VITE_PILOT_CONTACT: import.meta.env.VITE_PILOT_CONTACT,
  VITE_PILOT_PRIVACY_VERSION: import.meta.env.VITE_PILOT_PRIVACY_VERSION
})
