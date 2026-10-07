import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  const { app } = await buildApp(config);
  process.once('SIGINT', () => {
    void app.close();
  });
  process.once('SIGTERM', () => {
    void app.close();
  });
  try {
    const address = await app.listen({ port: config.PORT, host: config.HOST });
    console.log(
      JSON.stringify({ event: 'listening', address, mode: config.YAPPER_MODE }),
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
