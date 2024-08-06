import { InSiteWebSocketServer, InSiteWebSocketServerClient } from "insite-ws/server";
import type { AbilitiesSchema, Session, User } from "insite-users-server";


export class WSSCWithUser<AS extends AbilitiesSchema> extends InSiteWebSocketServerClient {
	declare wss: InSiteWebSocketServer<WSSCWithUser<AS>>;
	user?: User<AS>;
	lastUserId?: string;
	session?: Session<AS>;
}
