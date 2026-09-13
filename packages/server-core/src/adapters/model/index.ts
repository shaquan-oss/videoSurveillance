import { createModelGatewayFromEnv, ModelGateway, parseModelRegistry } from './model-gateway.ts';
import { aggregateSse, describePlatformError, JiutianProvider } from './providers/jiutian.provider.ts';

let gateway: ModelGateway | null = null;

export function getModelGateway(): ModelGateway {
  if (!gateway) gateway = createModelGatewayFromEnv();
  return gateway;
}

export { aggregateSse, createModelGatewayFromEnv, describePlatformError, JiutianProvider, ModelGateway, parseModelRegistry };
