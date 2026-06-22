export class TelegramService {
  constructor(
    private readonly options: {
      botToken: string;
      chatId: string;
    },
  ) {}

  async sendMessage(text: string): Promise<void> {
    if (!this.options.botToken || !this.options.chatId) {
      throw new Error("Telegram bot token/chat id chua duoc cau hinh.");
    }

    const response = await fetch(
      `https://api.telegram.org/bot${this.options.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          chat_id: this.options.chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Telegram sendMessage failed HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    if (!this.options.botToken) {
      throw new Error("Telegram bot token chua duoc cau hinh.");
    }

    const params = new URLSearchParams({
      timeout: "0",
      allowed_updates: JSON.stringify(["message"]),
    });
    if (offset !== undefined) params.set("offset", String(offset));

    const response = await fetch(
      `https://api.telegram.org/bot${this.options.botToken}/getUpdates?${params.toString()}`,
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Telegram getUpdates failed HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as {
      ok: boolean;
      result?: TelegramUpdate[];
      description?: string;
    };
    if (!data.ok) {
      throw new Error(data.description ?? "Telegram getUpdates failed.");
    }
    return data.result ?? [];
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: {
      id: number;
      type: string;
    };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
  };
}
