import "reflect-metadata";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  DynamicModule,
  Get,
  HttpCode,
  Inject,
  MessageEvent,
  Module,
  OnModuleDestroy,
  Patch,
  Post,
  Res,
  Sse
} from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Response } from "express";
import { Observable, Subject, interval, map, merge, of } from "rxjs";

import { ControlPlaneService } from "./control-plane";
import { readDashboardAsset, renderDashboardHtml } from "./dashboard-page";
import type {
  ProjectRuntimeControlInput,
  ProjectSetupInput,
  ProjectUpdateInput,
  ProjectUsageBudgetInput,
  ProviderModelQuery,
  UsageHistoryClearInput
} from "./domain";
import { validateGlobalConfigInput } from "./global-config";
import { Logger } from "./logger";

const CONTROL_PLANE = Symbol("CONTROL_PLANE");
const DASHBOARD_LOGGER = Symbol("DASHBOARD_LOGGER");

class DashboardEventStreamService implements OnModuleDestroy {
  private readonly updates = new Subject<MessageEvent>();
  private readonly unsubscribe: () => void;

  constructor(@Inject(CONTROL_PLANE) private readonly controlPlane: ControlPlaneService) {
    this.unsubscribe = this.controlPlane.subscribe((snapshot) => {
      this.updates.next({
        type: "snapshot",
        data: snapshot
      });
    });
  }

  stream(): Observable<MessageEvent> {
    return merge(
      of({
        type: "snapshot",
        data: this.controlPlane.snapshot()
      } satisfies MessageEvent),
      interval(15000).pipe(
        map(() => ({
          type: "heartbeat",
          data: {
            timestamp: new Date().toISOString()
          }
        } satisfies MessageEvent))
      ),
      this.updates.asObservable()
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe();
    this.updates.complete();
  }
}

@Controller()
class DashboardController {
  constructor(
    @Inject(CONTROL_PLANE) private readonly controlPlane: ControlPlaneService,
    @Inject(DASHBOARD_LOGGER) private readonly logger: Logger,
    private readonly eventStream: DashboardEventStreamService
  ) {}

  @Get("/")
  async root(@Res() response: Response): Promise<void> {
    response.type("text/html; charset=utf-8");
    response.send(
      renderDashboardHtml({
        initialSnapshot: this.controlPlane.snapshot(),
        setupContext: await this.controlPlane.dashboardSetupContext()
      })
    );
  }

  @Get("/assets/dashboard.js")
  async dashboardAsset(@Res() response: Response): Promise<void> {
    const asset = await readDashboardAsset().catch((error) => {
      this.logger.error("failed to load dashboard bundle", {
        error_message: error instanceof Error ? error.message : String(error)
      });
      return null;
    });
    if (!asset) {
      response.status(404).send("Dashboard bundle not found. Run `yarn dashboard:build` or `yarn build`.");
      return;
    }
    response.type("application/javascript; charset=utf-8");
    response.send(asset);
  }

  @Get("/favicon.ico")
  @HttpCode(204)
  favicon(): void {}

  @Get("/api/snapshot")
  snapshot() {
    return this.controlPlane.snapshot();
  }

  @Get("/api/setup/context")
  async setupContext() {
    return this.controlPlane.dashboardSetupContext();
  }

  @Get("/api/settings/global")
  async readGlobal() {
    return this.controlPlane.readGlobalConfig();
  }

  @Patch("/api/settings/global")
  async updateGlobal(@Body() body: unknown) {
    return this.controlPlane.updateGlobalConfig(validateGlobalConfigInput(body));
  }

  @Post("/api/provider-models")
  async providerModels(@Body() body: ProviderModelQuery) {
    return this.controlPlane.listProviderModels(body);
  }

  @Get("/api/providers")
  providers() {
    return this.controlPlane.listProviders();
  }

  @Get("/api/usage-metrics")
  async usageMetrics() {
    return this.controlPlane.usageMetrics();
  }

  @Post("/api/usage-metrics/clear")
  async clearUsageMetrics(@Body() body: unknown) {
    return this.controlPlane.clearUsageHistory(validateUsageHistoryClearInput(body));
  }

  @Patch("/api/usage-budgets")
  async usageBudget(@Body() body: ProjectUsageBudgetInput) {
    return this.controlPlane.updateUsageBudget(body);
  }

  @Get("/api/projects")
  async projects() {
    return this.controlPlane.listProjects();
  }

  @Post("/api/projects")
  async createProject(@Body() body: ProjectSetupInput) {
    return this.controlPlane.createProject(body);
  }

  @Patch("/api/projects")
  async updateProject(@Body() body: ProjectUpdateInput) {
    return this.controlPlane.updateProject(body);
  }

  @Post("/api/projects/start")
  async startProject(@Body() body: ProjectRuntimeControlInput) {
    return this.controlPlane.startProject(body);
  }

  @Post("/api/projects/stop")
  async stopProject(@Body() body: ProjectRuntimeControlInput) {
    return this.controlPlane.stopProject(body);
  }

  @Delete("/api/projects")
  async deleteProject(@Body() body: { id: string }) {
    await this.controlPlane.removeProject(body.id);
    return { ok: true };
  }

  @Sse("/api/events")
  events(): Observable<MessageEvent> {
    return this.eventStream.stream();
  }
}

@Module({})
class DashboardHttpModule {
  static register(controlPlane: ControlPlaneService, logger: Logger): DynamicModule {
    return {
      module: DashboardHttpModule,
      controllers: [DashboardController],
      providers: [
        DashboardEventStreamService,
        {
          provide: CONTROL_PLANE,
          useValue: controlPlane
        },
        {
          provide: DASHBOARD_LOGGER,
          useValue: logger.child({ component: "dashboard" })
        }
      ]
    };
  }
}

export class DashboardServerHost {
  private app: INestApplication | null = null;

  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly logger: Logger
  ) {}

  async start(port: number, host: string): Promise<{ host: string; port: number; url: string }> {
    if (this.app) {
      const address = this.app.getHttpServer().address();
      if (address && typeof address !== "string") {
        const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`;
        this.controlPlane.setDashboardState(true, url);
        return {
          host,
          port: address.port,
          url
        };
      }
    }

    this.app = await NestFactory.create(DashboardHttpModule.register(this.controlPlane, this.logger), {
      logger: false
    });
    await this.app.listen(port, host);

    const address = this.app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve dashboard server address");
    }

    const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`;
    this.controlPlane.setDashboardState(true, url);
    this.logger.info("dashboard server started", {
      host,
      port: address.port,
      url
    });
    return {
      host,
      port: address.port,
      url
    };
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
    }
    this.controlPlane.setDashboardState(false, null);
  }
}

function validateUsageHistoryClearInput(value: unknown): UsageHistoryClearInput {
  if (value == null || value === "") {
    return {};
  }

  if (typeof value !== "object") {
    throw new BadRequestException("usage history clear payload must be an object");
  }

  const candidate = value as { id?: unknown };
  if (candidate.id == null || candidate.id === "") {
    return {};
  }
  if (typeof candidate.id !== "string") {
    throw new BadRequestException("usage history clear id must be a string");
  }

  return { id: candidate.id };
}
