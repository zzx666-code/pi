import { loadConfig } from "../config.ts";
import { createMysqlPool } from "../db/mysql.ts";
import { MySqlKnowledgeGateway } from "../knowledge/mysql-knowledge.ts";
import { createAgentApp } from "./app.ts";
import { MySqlConversationStore } from "./conversation-store.ts";
import { MySqlDeskAuditStore } from "./desk-audit.ts";
import { CommerceHttpGateway } from "./gateways.ts";
import { createCustomerModelRuntime } from "./model-runtime.ts";
import { CustomerServiceAgentService } from "./service.ts";

const config = loadConfig();
const pool = createMysqlPool(config.mysqlUrl);
const commerce = new CommerceHttpGateway(config.commerceBaseUrl, config.commerceInternalToken);
const knowledge = new MySqlKnowledgeGateway(pool);
const runtime = await createCustomerModelRuntime(config);
const service = new CustomerServiceAgentService({
	model: runtime.model,
	streamFn: runtime.models.streamSimple.bind(runtime.models),
	commerce,
	knowledge,
	conversations: new MySqlConversationStore(pool),
	deskAudit: new MySqlDeskAuditStore(pool),
});
const app = createAgentApp(service, commerce, {
	authSecret: config.authSecret,
	demoUserId: config.demoUserId,
	deskToken: config.deskToken,
	allowedOrigin: process.env.WEB_ORIGIN,
	refunds: commerce,
});

app.addHook("onClose", async () => {
	await pool.end();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void app.close();
	});
}

await app.listen({ host: "0.0.0.0", port: config.agentPort });
