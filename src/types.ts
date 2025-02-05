import type { AbilitiesSchema } from "insite-common";
import type { InSiteCollections } from "insite-db";
import type { Users, Options as UsersOptions } from "insite-users-server";
import type { IncomingTransport, WithOptionalOnTransfer } from "insite-ws-transfers/node";
import type { InSiteWebSocketServer } from "insite-ws/server";
import type {
	OrgsExtendedPublicationOptions,
	OrgsPublicationOptions,
	RolesPublicationOptions,
	UserPublicationOptions,
	UsersExtendedPublicationOptions,
	UsersPublicationOptions
} from "./publications";
import type { WSSCWithUser } from "./WSSCWithUser";


export type Options<AS extends AbilitiesSchema> = {
	wss: WithOptionalOnTransfer<InSiteWebSocketServer<WSSCWithUser<AS>>, WSSCWithUser<AS>>;
	collections?: InSiteCollections;
	users: Users<AS> | UsersOptions<AS>;
	publication?: UsersPublicationOptions;
	extendedPublication?: UsersExtendedPublicationOptions;
	userPublication?: UserPublicationOptions;
	roles?: {
		publication?: RolesPublicationOptions;
	};
	orgs?: {
		publication?: OrgsPublicationOptions;
		extendedPublication?: OrgsExtendedPublicationOptions;
	};
	incomingTransport?: IncomingTransport<WSSCWithUser<AS>>;
};
