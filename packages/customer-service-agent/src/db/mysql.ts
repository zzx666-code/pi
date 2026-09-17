import { createPool, type Pool } from "mysql2/promise";

export function createMysqlPool(mysqlUrl: string): Pool {
	return createPool({
		uri: mysqlUrl,
		connectionLimit: 10,
		enableKeepAlive: true,
		decimalNumbers: true,
	});
}
