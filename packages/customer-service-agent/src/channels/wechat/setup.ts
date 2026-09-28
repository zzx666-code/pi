import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";
import { loadWechatWorkerConfig } from "./config.ts";
import { fetchWechatQrCode, pollWechatQrStatus, type WechatCredentials } from "./ilink.ts";

const config = loadWechatWorkerConfig();
const deadline = Date.now() + 8 * 60 * 1000;
let refreshCount = 0;

while (refreshCount < 3 && Date.now() < deadline) {
	const qr = await fetchWechatQrCode();
	const qrContent = qr.qrcode_img_content || qr.qrcode;
	console.log("请使用微信扫描二维码并在手机上确认：");
	qrcode.generate(qrContent, { small: true });
	console.log(`二维码链接：${qrContent}`);

	let pollBaseUrl = "https://ilinkai.weixin.qq.com";
	let verifyCode: string | undefined;
	while (Date.now() < deadline) {
		const status = await pollWechatQrStatus(qr.qrcode, pollBaseUrl, verifyCode);
		if (status.status === "scaned") {
			verifyCode = undefined;
			console.log("二维码已扫描，请在手机上确认。");
			continue;
		}
		if (status.status === "need_verifycode") {
			const readline = createInterface({ input, output });
			verifyCode = (await readline.question("请输入手机微信显示的数字：")).trim();
			readline.close();
			continue;
		}
		if (status.status === "scaned_but_redirect" && status.redirect_host) {
			pollBaseUrl = status.redirect_host.startsWith("http")
				? status.redirect_host
				: `https://${status.redirect_host}`;
			continue;
		}
		if (status.status === "verify_code_blocked") {
			throw new Error("验证码错误次数过多，请稍后重新执行微信登录");
		}
		if (status.status === "binded_redirect") {
			throw new Error("该微信机器人已经绑定；如需重建本地凭据，请先在微信侧解除原绑定");
		}
		if (status.status === "expired") break;
		if (status.status !== "confirmed") continue;
		if (!status.bot_token || !status.ilink_bot_id) throw new Error("微信登录成功响应缺少机器人凭据");

		const credentials: WechatCredentials = {
			botToken: status.bot_token,
			botId: status.ilink_bot_id,
			baseUrl: status.baseurl ?? "https://ilinkai.weixin.qq.com",
			ownerUserId: status.ilink_user_id,
			createdAt: new Date().toISOString(),
		};
		await mkdir(dirname(config.credentialsPath), { recursive: true });
		await writeFile(config.credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		console.log(`微信登录成功，凭据已保存到 ${config.credentialsPath}`);
		console.log("下一步运行：npm run wechat:start");
		process.exitCode = 0;
		break;
	}
	if (process.exitCode === 0) break;
	refreshCount += 1;
}

if (process.exitCode !== 0) throw new Error("微信登录超时，请重新执行 npm run wechat:setup");
