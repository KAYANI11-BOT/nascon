// Placeholder only: no client, network request or credential prompt.
export function getSupabaseConfiguration(){const url=import.meta.env.VITE_SUPABASE_URL as string|undefined;const anonKey=import.meta.env.VITE_SUPABASE_ANON_KEY as string|undefined;return {url:url??'',anonKey:anonKey??'',configured:Boolean(url&&anonKey),demoMode:import.meta.env.VITE_DEMO_MODE!=='false'};}
export class ConfigurationRequiredError extends Error {constructor(){super('Supabase adapters are not connected. Configuration and backend implementation are required.');this.name='ConfigurationRequiredError';}}
