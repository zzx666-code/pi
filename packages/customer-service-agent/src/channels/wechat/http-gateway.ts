import type { WechatChannelReply, WechatInboundMessage } from "./service.ts";

export class WechatAgentHttpGateway {
	private readonly baseUrl: string;
	private readonly channelToken: string;

	constructor(baseUrl: string, channelToken: string) {
		this.baseUrl = baseUrl;
		this.channelToken = channelToken;
	}

	async handleInbound(message: WechatInboundMessage): Promise<WechatChannelReply> {
		const response = await fetch(`${this.baseUrl}/api/internal/channels/wechat/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-channel-token": this.channelToken },
			body: JSON.stringify(message),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
			throw new Error(body?.message ?? `Agent channel API returned ${response.status}`);
		}
		return (await response.json()) as WechatChannelReply;
	}
}
