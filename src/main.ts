/** CLI 入口；组合逻辑在 server.ts，便于宿主注册 IRMessage interceptor 后嵌入。 */
import { startGateway } from "./server.ts";

startGateway();
