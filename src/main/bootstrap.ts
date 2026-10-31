import {
  createAppServices,
  type AppServices,
  type AppServicesOptions,
} from './app-services';
import { registerIpc } from './ipc';

export interface BootstrapApplicationOptions extends AppServicesOptions {
  createMainWindow: () => Promise<void>;
}

export async function bootstrapApplication(
  options: BootstrapApplicationOptions,
): Promise<AppServices> {
  const { createMainWindow, ...serviceOptions } = options;
  const services = await createAppServices(serviceOptions);

  try {
    registerIpc(services);
    await createMainWindow();
    return services;
  } catch (error) {
    await services.close();
    throw error;
  }
}
