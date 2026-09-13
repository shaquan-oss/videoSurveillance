// 本地开发时从仓库根目录的 .env 读取配置；
// 容器部署时环境变量已由编排注入，dotenv 不会覆盖已存在的值，所以两种方式都安全。
import 'dotenv/config';
// 本地开发时从仓库根目录的 .env 读取配置；
// 容器部署时环境变量已由编排注入，dotenv 不会覆盖已存在的值，所以两种方式都安全。
import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.ts';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.ts';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.ts';
import { loadConfig } from './config/configuration.ts';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // 配置有问题就立刻失败，不要等到用户点按钮才发现
  const config = loadConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // 关闭默认 body 日志，避免把用户内容写进日志
    logger: config.env === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug'],
  });

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  // 超时保护：模型调用较慢，但不要让连接无限挂着
  app.set('trust proxy', 1);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('企业智能知识中枢 API')
    .setDescription('接口文档。阶段一包含账号与文件管理；知识库与对话接口见后续阶段。')
    .setVersion('0.1.0')
    .addCookieAuth('khub_session')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // 优雅关闭：先停止接单，等在处理的请求结束，再断开数据库与 Redis
  app.enableShutdownHooks();

  await app.listen(config.apiPort, '0.0.0.0');

  logger.log(`接口服务已启动：http://127.0.0.1:${config.apiPort}/api`);
  logger.log(`接口文档：http://127.0.0.1:${config.apiPort}/api/docs`);
  logger.log(`运行环境：${config.env}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('启动失败：', err);
  process.exit(1);
});
