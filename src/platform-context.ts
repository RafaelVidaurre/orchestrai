import "reflect-metadata";

import { DynamicModule, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { ControlPlaneService } from "./control-plane";
import { Logger } from "./logger";

const PROJECTS_ROOT = Symbol("PROJECTS_ROOT");
const PLATFORM_ENV = Symbol("PLATFORM_ENV");
const PLATFORM_LOGGER = Symbol("PLATFORM_LOGGER");

@Module({})
class PlatformContextModule {
  static register(projectsRoot: string, env: NodeJS.ProcessEnv, logger: Logger): DynamicModule {
    return {
      module: PlatformContextModule,
      providers: [
        {
          provide: PROJECTS_ROOT,
          useValue: projectsRoot
        },
        {
          provide: PLATFORM_ENV,
          useValue: env
        },
        {
          provide: PLATFORM_LOGGER,
          useValue: logger
        },
        {
          provide: ControlPlaneService,
          inject: [PROJECTS_ROOT, PLATFORM_LOGGER, PLATFORM_ENV],
          useFactory: (root: string, rootLogger: Logger, runtimeEnv: NodeJS.ProcessEnv) =>
            new ControlPlaneService(root, rootLogger, runtimeEnv)
        }
      ],
      exports: [ControlPlaneService]
    };
  }
}

export async function createPlatformContext(
  projectsRoot: string,
  env: NodeJS.ProcessEnv,
  logger: Logger
): Promise<{ controlPlane: ControlPlaneService; close(): Promise<void> }> {
  const app = await NestFactory.createApplicationContext(PlatformContextModule.register(projectsRoot, env, logger), {
    logger: false
  });
  const controlPlane = app.get(ControlPlaneService);
  await controlPlane.initialize();
  return {
    controlPlane,
    close: async () => {
      await controlPlane.stop().catch(() => undefined);
      await app.close();
    }
  };
}
