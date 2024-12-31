import { InSiteWebSocketServer, InSiteWebSocketServerClient } from "insite-ws/server";
import type { AbilitiesSchema } from "insite-common";
import type { Session, SessionDoc, User } from "insite-users-server";


export class WSSCWithUser<AS extends AbilitiesSchema> extends InSiteWebSocketServerClient {
	declare wss: InSiteWebSocketServer<WSSCWithUser<AS>>;
	isRejected?: boolean;
	sessionProps?: Partial<SessionDoc>;
	user?: User<AS>;
	lastUserId?: string;
	session?: Session<AS>;
}
