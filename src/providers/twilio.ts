import twilio from 'twilio';
import type { Run } from '../contracts.js';
import type { Config } from '../config.js';

export interface Dialer {
  dial(run: Run): Promise<string>;
  hangup(callSid: string): Promise<void>;
}

export class TwilioDialer implements Dialer {
  private readonly client: ReturnType<typeof twilio>;
  constructor(private readonly config: Config) {
    this.client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN, {
      timeout: 15_000,
      autoRetry: false,
    });
  }

  async dial(run: Run): Promise<string> {
    const call = await this.client.calls.create({
      to: run.request.to,
      from: this.config.TWILIO_FROM_NUMBER!,
      url: `${this.config.PUBLIC_BASE_URL}/twilio/voice/${run.id}`,
      method: 'POST',
      statusCallback: `${this.config.PUBLIC_BASE_URL}/twilio/status/${run.id}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      machineDetection: 'Enable',
      machineDetectionTimeout: 30,
      timeout: 30,
      timeLimit: run.request.maxDurationSeconds,
    });
    return call.sid;
  }

  async hangup(callSid: string): Promise<void> {
    await this.client.calls(callSid).update({ status: 'completed' });
  }
}
