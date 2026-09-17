import { loadConfig } from "../config.ts";
import { createMysqlPool } from "../db/mysql.ts";
import { MySqlCommerceRepository } from "../db/mysql-commerce-repository.ts";
import { createCommerceApp } from "./app.ts";

const config = loadConfig();
const pool = createMysqlPool(config.mysqlUrl);
const app = createCommerceApp(new MySqlCommerceRepository(pool), {
	internalToken: config.commerceInternalToken,
});

app.addHook("onClose", async () => {
	await pool.end();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void app.close();
	});
}

await app.listen({ host: "0.0.0.0", port: config.commercePort });
