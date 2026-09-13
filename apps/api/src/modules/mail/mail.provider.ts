import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingMail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

/**
 * 邮件投递通道。
 *
 * 抽成独立 provider 的原因：SMTP 只是当下这一种实现，
 * 以后换成企业邮 API 或消息队列只改这一个文件，业务代码不用动。
 * 未配置 SMTP 时 `isConfigured()` 返回 false，上层据此把草稿落成 unsent，
 * 而不是抛错 —— 草稿本身仍然可用（复制正文 / 导出 .eml）。
 */
@Injectable()
export class MailProvider {
  private readonly logger = new Logger('MailProvider');
  private readonly host = process.env.SMTP_HOST?.trim() ?? '';
  private readonly port = Number(process.env.SMTP_PORT ?? '465');
  private readonly user = process.env.SMTP_USER?.trim() ?? '';
  private readonly password = process.env.SMTP_PASSWORD ?? '';
  private readonly from = process.env.SMTP_FROM?.trim() ?? '';

  private transporter: Transporter | null = null;

  isConfigured(): boolean {
    return !!(this.host && this.user && this.password);
  }

  fromAddress(): string {
    return this.from || this.user;
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.host,
        port: this.port,
        // 465 是隐式 TLS，587 走 STARTTLS
        secure: this.port === 465,
        auth: { user: this.user, pass: this.password },
      });
    }
    return this.transporter;
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('未配置 SMTP');
    }
    await this.getTransporter().sendMail({
      from: this.fromAddress(),
      to: mail.to.join(', '),
      cc: mail.cc.length ? mail.cc.join(', ') : undefined,
      subject: mail.subject,
      text: mail.body,
    });
    this.logger.log(`邮件已投递：${mail.subject} → ${mail.to.join(', ')}`);
  }
}
