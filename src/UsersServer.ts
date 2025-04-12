import type { AbilitiesSchema } from "insite-common";
import type { ChangeStreamDocument } from "insite-db";
import {
	Users,
	type Org,
	type OrgDoc,
	type Role,
	type RoleDoc,
	type Session,
	type User
} from "insite-users-server";
import { setupHandlers } from "./handlers";
import {
	AbilitiesPublication,
	OrgsExtendedPublication,
	OrgsPublication,
	RolesPublication,
	SessionsPublication,
	UserPublication,
	UsersExtendedPublication,
	UsersPublication
} from "./publications";
import type { Options } from "./types";
import type { WSSCWithUser } from "./WSSCWithUser";


export class UsersServer<AS extends AbilitiesSchema> {
	constructor(options: Options<AS>) {
		this.#initPromise = this.init!(options);
		
	}
	
	#userWsMap = new WeakMap<User<AS>, Set<WSSCWithUser<AS>>>();
	#sessionsWsMap = new WeakMap<Session<AS>, WSSCWithUser<AS>>();
	
	wss!: Options<AS>["wss"];
	users!: Users<AS>;
	incomingTransport!: Options<AS>["incomingTransport"];
	
	abilitiesPublication!: AbilitiesPublication<AS>;
	rolesPublication!: RolesPublication<AS>;
	usersPublication!: UsersPublication<AS>;
	usersExtendedPublication!: UsersExtendedPublication<AS>;
	userPublication!: UserPublication<AS>;
	orgsPublication!: OrgsPublication<AS>;
	orgsExtendedPublication!: OrgsExtendedPublication<AS>;
	sessionsPublication!: SessionsPublication<AS>;
	
	init? = async (options: Options<AS>) => {
		
		const {
			wss,
			collections,
			users,
			publication: publicationOptions,
			extendedPublication: extendedPublicationOptions,
			userPublication: userPublicationOptions,
			roles: rolesOptions = {},
			orgs: orgsOptions = {},
			incomingTransport
		} = options;
		
		const {
			publication: rolesPublicationOptions
		} = rolesOptions;
		
		const {
			publication: orgsPublicationOptions,
			extendedPublication: orgsExtendedPublicationOptions
		} = orgsOptions;
		
		this.wss = wss;
		this.users = users instanceof Users ? users : await Users.init(collections!, users);
		this.incomingTransport = incomingTransport;
		
		for (const user of this.users.values())
			this.#handleUserCreate(user);
		
		this.abilitiesPublication = new AbilitiesPublication<AS>(this.users.abilities);
		this.rolesPublication = new RolesPublication<AS>(this.users.roles, rolesPublicationOptions);
		this.usersPublication = new UsersPublication<AS>(this.users, publicationOptions);
		this.usersExtendedPublication = new UsersExtendedPublication<AS>(this.users, extendedPublicationOptions);
		this.userPublication = new UserPublication<AS>(this.users, userPublicationOptions);
		this.orgsPublication = new OrgsPublication<AS>(this.users.orgs, orgsPublicationOptions);
		this.orgsExtendedPublication = new OrgsExtendedPublication<AS>(this.users.orgs, orgsExtendedPublicationOptions);
		this.sessionsPublication = new SessionsPublication<AS>(this.users.sessions);
		
		this.users.on("roles-update", this.#handleRolesUpdate);
		this.users.on("roles-role-update", this.#handleRolesRoleUpdate);
		this.users.on("user-create", this.#handleUserCreate);
		this.users.on("user-is-online", this.#handleUserIsOnline);
		this.users.on("session-delete", this.#handleSessionDelete);
		this.users.on("orgs-update", this.#handleOrgsUpdate);
		this.users.on("orgs-org-update", this.#handleOrgsOrgUpdate);
		this.users.on("user-permissions-change", this.#handleUserPermissionsChange);
		
		this.wss.onRequest("login", this.#handleClientRequestLogin);
		this.wss.onRequest("logout", this.#handleClientRequestLogout);
		this.wss.on("client-closed", this.#handleClientClosed);
		
		setupHandlers<AS>(this);
		
		return this;
	};
	
	#initPromise;
	
	whenReady() {
		return this.#initPromise;
	}
	
	#makeSessionProps({ userAgent, remoteAddress, sessionProps }: WSSCWithUser<AS>) {
		return {
			userAgent,
			remoteAddress,
			...sessionProps,
			isOnline: true
		};
	}
	
	setSession(wssc: WSSCWithUser<AS>, session: Session<AS> | string | null | undefined, shouldProlong?: boolean) {
		if (session === null)
			session = undefined;
		else if (typeof session == "string")
			session = this.users.sessions.get(session);
		
		if (wssc.session !== session) {
			if (wssc.session)
				this.#sessionsWsMap.delete(wssc.session);
			
			if (session && !wssc.isRejected) {
				wssc.session = session;
				wssc.user = session.user;
				wssc.lastUserId = session.user._id;
				
				this.#userWsMap.get(session.user)?.add(wssc);
				this.#sessionsWsMap.set(session, wssc);
				
				if (shouldProlong)
					void session.prolong(this.#makeSessionProps(wssc));
				
			} else {
				delete wssc.session;
				delete wssc.user;
				
				this.#userWsMap.get(wssc.user!)?.delete(wssc);
			}
			
			this.wss.emit("client-session", wssc, shouldProlong);
		}
		
	}
	
	#login = async (wssc: WSSCWithUser<AS>, email: string, password: string) => {
		if (!wssc.isRejected) {
			const session = await this.users.login(email, password, this.#makeSessionProps(wssc));
			
			if (session)
				this.setSession(wssc, session);
		}
		
	};
	
	#logout = (wssc: WSSCWithUser<AS>) => {
		if (wssc.session) {
			this.users.logout(wssc.session);
			this.setSession(wssc, null);
		}
		
	};
	
	#handleRolesUpdate = () =>
		this.rolesPublication.flushInitial();
	
	#handleRolesRoleUpdate = (role: Role<AS>, next: ChangeStreamDocument<RoleDoc>) =>
		next && this.rolesPublication.skip(next);
	
	#handleUserCreate = (user: User<AS>) =>
		this.#userWsMap.set(user, new Set<WSSCWithUser<AS>>());
	
	#handleUserIsOnline = ({ _id, isOnline }: User<AS>) => {
		const updates = { _id, isOnline };
		
		for (const usersSubscription of this.usersPublication.subscriptions) {
			const [ wssc ] = usersSubscription.args;
			if (wssc.user && wssc.user._id !== _id)
				usersSubscription.handler([ [ "u"/* update */, updates, true ] ]);
		}
		
	};
	
	#handleSessionDelete = (session: Session<AS>) => {
		const wssc = this.#sessionsWsMap.get(session);
		
		if (wssc)
			this.setSession(wssc, null);
		
	};
	
	#handleOrgsUpdate = () => {
		
		this.orgsPublication.flushInitial();
		this.orgsExtendedPublication.flushInitial();
		
	};
	
	#handleOrgsOrgUpdate = (org: Org<AS>, next: ChangeStreamDocument<OrgDoc>) => {
		if (next) {
			this.orgsPublication.skip(next);
			this.orgsExtendedPublication.skip(next);
		}
		
	};
	
	#handleUserPermissionsChange = (user: User<AS>) => {
		const webSockets = this.#userWsMap.get(user);
		
		if (webSockets)
			this.wss.emit("should-renew-subscriptions", [ ...webSockets ]);
		
	};
	
	#handleClientRequestLogin = (wssc: WSSCWithUser<AS>, email: string, password: string) =>
		this.#login(wssc, email, password);
	
	#handleClientRequestLogout = (wssc: WSSCWithUser<AS>) =>
		this.#logout(wssc);
	
	#handleClientClosed = (wssc: WSSCWithUser<AS>) => {
		wssc.session?.offline();
		this.setSession(wssc, null);
		
	};
	
	
	static init<IAS extends AbilitiesSchema>(options: Options<IAS>) {
		const usersServer = new UsersServer(options);
		
		return usersServer.whenReady();
	}
	
}
