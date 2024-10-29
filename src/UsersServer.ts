import type { InSiteWebSocketServer } from "insite-ws/server";
import type { IncomingTransfer, IncomingTransport } from "insite-ws-transfers/node";
import {
	_ids,
	Err,
	includesAll,
	isEmpty,
	removeAll,
	StringKey,
	union,
	without
} from "@nesvet/n";
import type { Abilities, AbilitiesSchema } from "insite-common";
import { Binary, type ChangeStreamDocument, InSiteCollections } from "insite-db";
import {
	type AbilityParamItems,
	type AbilityParamNumber,
	type AbilityWithParams,
	type GenericAbilities,
	type Org,
	type OrgDoc,
	type Role,
	type RoleDoc,
	type Session,
	type SessionDoc,
	type User,
	type UserDoc,
	Users,
	type Options as UsersOptions
} from "insite-users-server";
import {
	AbilitiesPublication,
	OrgsExtendedPublication,
	type OrgsExtendedPublicationOptions,
	OrgsPublication,
	type OrgsPublicationOptions,
	RolesPublication,
	type RolesPublicationOptions,
	SessionsPublication,
	UserPublication,
	type UserPublicationOptions,
	UsersExtendedPublication,
	type UsersExtendedPublicationOptions,
	UsersPublication,
	type UsersPublicationOptions
} from "./publications";
import { regexps } from "./regexps";
import { WSSCWithUser } from "./WSSCWithUser";

const avatarTypesAccepted = [ "image/webp" ];
const maxAvatarSize = 1024 * 512;

export type Options<AS extends AbilitiesSchema> = {
	wss: InSiteWebSocketServer<WSSCWithUser<AS>>;
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
	getSessionProps?: (wssc: WSSCWithUser<AS>) => Partial<SessionDoc>;
	incomingTransport?: IncomingTransport;
};


export class UsersServer<AS extends AbilitiesSchema> {
	constructor(options: Options<AS>) {
		this.initPromise = this.init!(options);
		
	}
	
	private userWsMap = new WeakMap<User<AS>, Set<WSSCWithUser<AS>>>();
	private sessionsWsMap = new WeakMap<Session<AS>, WSSCWithUser<AS>>();
	
	wss!: Options<AS>["wss"];
	users!: Users<AS>;
	getSessionProps!: Options<AS>["getSessionProps"];
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
			getSessionProps,
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
		this.getSessionProps = getSessionProps;
		this.incomingTransport = incomingTransport;
		
		for (const user of this.users.values())
			this.handleUserCreate(user);
		
		this.abilitiesPublication = new AbilitiesPublication<AS>(this.users.abilitiesMap);
		this.rolesPublication = new RolesPublication<AS>(this.users.roles, rolesPublicationOptions);
		this.usersPublication = new UsersPublication<AS>(this.users, publicationOptions);
		this.usersExtendedPublication = new UsersExtendedPublication<AS>(this.users, extendedPublicationOptions);
		this.userPublication = new UserPublication<AS>(this.users, userPublicationOptions);
		this.orgsPublication = new OrgsPublication<AS>(this.users.orgs, orgsPublicationOptions);
		this.orgsExtendedPublication = new OrgsExtendedPublication<AS>(this.users.orgs, orgsExtendedPublicationOptions);
		this.sessionsPublication = new SessionsPublication<AS>(this.users.sessions);
		
		this.users.on("roles-update", this.handleRolesUpdate);
		this.users.on("roles-role-update", this.handleRolesRoleUpdate);
		this.users.on("user-create", this.handleUserCreate);
		this.users.on("user-is-online", this.handleUserIsOnline);
		this.users.on("session-delete", this.handleSessionDelete);
		this.users.on("orgs-update", this.handleOrgsUpdate);
		this.users.on("orgs-org-update", this.handleOrgsOrgUpdate);
		this.users.on("user-permissions-change", this.handleUserPermissionsChange);
		
		this.wss.onRequest("login", this.handleClientRequestLogin);
		this.wss.onRequest("logout", this.handleClientRequestLogout);
		this.wss.on("client-closed", this.handleClientClosed);
		
		
		/*
		 * Handlers
		 */
		
		/* Users */
		
		this.wss.onRequest("users.people.check-email", (wssc, email: string) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users")) {
				if (!regexps.email.test(email))
					throw new Err("Not email", "notemail");
				
				if (this.users.byEmail.has(email))
					throw new Err("Email already exists", "exists");
			}
			
		});
		
		this.wss.onRequest("users.people.add", async (wssc, { roles, org, ...rest }: Omit<UserDoc, "_id" | "createdAt">) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users")) {
				if (!roles.length)
					throw new Err("Roles shouldn't be empty", "emptyroles");
				
				if (!includesAll(wssc.user.slaveRoleIds, roles))
					throw new Err("Can't assign role the user is not involved in", "forbiddenrole");
				
				if (org && !wssc.user.slaveIds.includes(org))
					throw new Err("Can't assign org the user is not master of", "forbiddenorg");
				
				await this.users.new({ roles, org, ...rest });
			}
			
		});
		
		this.wss.onRequest("users.people.change-password", async (wssc, _id: string, newPassword: string) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.permissiveIds.includes(_id)) {
				if (typeof newPassword != "string")
					throw new Err("Type of password is incorrect", "wrongpasswordtype");
				
				if (!newPassword)
					throw new Err("Password can't be empty", "emptypassword");
				
				await this.users.changePassword(_id, newPassword);
			}
			
		});
		
		this.wss.onRequest("users.people.update", async (wssc, _id: string, updates: Omit<UserDoc, "_id" | "createdAt">) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.permissiveIds.includes(_id)) {
				if (updates.roles) {
					if (!updates.roles.length)
						throw new Err("Roles can't be empty", "emptyroles");
					
					if (!includesAll(wssc.user.slaveRoleIds, updates.roles))
						throw new Err("Can't assign role the user is not involved in", "forbiddenrole");
					
					const user = this.users.get(_id);
					
					if (user)
						updates.roles =
							user.isRoot ?
								[ "root" ] :
								this.users.roles.cleanUpIds(
									without(user.ownRoleIds, wssc.user.slaveRoleIds).concat(updates.roles)
								);
				}
				
				if (updates.org && !wssc.user.slaveIds.includes(updates.org))
					throw new Err("Can't assign org the user is not master of", "forbiddenorg");
				
				if (!isEmpty(updates))
					await this.users.collection.updateOne({ _id }, { $set: updates });
			}
			
		});
		
		this.wss.onRequest("users.people.delete", async (wssc, _id: string) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.slaveIds.includes(_id))
				await this.users.collection.deleteOne({ _id });
			
		});
		
		
		/* Sessions */
		
		this.wss.onRequest("users.people.destroy-session", async (wssc, sessionId: string) => {
			if (
				wssc.user?.abilities.inSite?.sections?.includes("users") &&
				wssc.user.permissiveIds.includes(this.users.bySessionId.get(sessionId)?._id)
			)
				await this.users.sessions.collection.deleteOne({ _id: sessionId });
			
		});
		
		
		/* Avatars */
		
		if (this.incomingTransport) {
			const getAvatarTransferProps = (check?: (wssc: WSSCWithUser<AS>, transfer: IncomingTransfer) => boolean | Promise<boolean | undefined> | undefined) => ({
				
				begin: async (wssc: WSSCWithUser<AS>, transfer: IncomingTransfer) => (
					(!check || await check(wssc, transfer)) &&
					avatarTypesAccepted.includes(transfer.metadata.type as string) &&
					transfer.size <= maxAvatarSize
				),
				
				end: async (wssc: WSSCWithUser<AS>, { data, metadata: { type, _id } }: IncomingTransfer) => {
					const binaryData = Binary.createFromBase64((data as string).slice((data as string).indexOf(",")));
					
					const ts = Date.now().toString(36);
					
					await Promise.all([
						this.users.avatars.collection.replaceOne({ _id: _id as string }, {
							type: type as string,
							size: binaryData.length(),
							ts,
							data: binaryData
						}, { upsert: true }),
						this.users.collection.updateOne({ _id: _id as string }, { $set: { avatar: ts } })
					]);
					
				}
				
			});
			
			this.incomingTransport.on("users.people.avatar", getAvatarTransferProps(
				(wssc: WSSCWithUser<AS>, { metadata: { _id } }: IncomingTransfer) =>
					wssc.user?.abilities.inSite?.sections?.includes("users") &&
					wssc.user.permissiveIds.includes(_id as string)
			));
			
			this.incomingTransport.on("user.avatar", getAvatarTransferProps(
				(wssc: WSSCWithUser<AS>, transfer: IncomingTransfer) =>
					wssc.user &&
					wssc.user._id === transfer.metadata._id
			));
		}
		
		const deleteAvatar = async (_id: string) => {
			
			await Promise.all([
				this.users.avatars.collection.deleteOne({ _id }),
				this.users.collection.updateOne({ _id }, { $set: { avatar: null } })
			]);
			
		};
		
		this.wss.onRequest("users.people.delete-avatar", async (wssc, _id: string) =>
			wssc.user?.abilities.inSite?.sections?.includes("users") &&
			wssc.user.permissiveIds.includes(_id) &&
			await deleteAvatar(_id)
		);
		
		this.wss.onRequest("user.delete-avatar", async (wssc, _id: string) =>
			wssc.user &&
			wssc.user._id === _id &&
			await deleteAvatar(_id)
		);
		
		
		/* Orgs */
		
		this.wss.onRequest("users.orgs.add", async (wssc, org: Omit<OrgDoc, "_id" | "createdAt" | "owners">) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users")) {
				if (!org.title)
					throw new Err("Title can't be empty", "emptytitle");
				
				await this.users.orgs.new(org, wssc.user._id);
			}
			
		});
		
		this.wss.onRequest("users.orgs.update", async (wssc, _id, updates: Omit<OrgDoc, "_id" | "createdAt">) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.slaveIds.includes(_id)) {
				if (updates.title !== undefined && !updates.title)
					throw new Err("Title can't be empty", "emptytitle");
				
				if (updates.owners) {
					if (!includesAll(wssc.user.slaveIds, updates.owners))
						throw new Err("Can't assign owners the user is not master of", "forbiddenowners");
					
					const org = this.users.orgs.get(_id);
					
					if (org)
						updates.owners =
							this.users.sortIds(
								union(
									without(org.ownerIds, wssc.user.slaveIds),
									without(updates.owners, [ org._id, ..._ids(org.slaveOrgs) ])
								)
							);
				}
				
				if (!isEmpty(updates))
					await this.users.orgs.collection.updateOne({ _id }, { $set: updates });
			}
			
		});
		
		this.wss.onRequest("users.orgs.delete", async (wssc, _id: string) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.slaveIds.includes(_id))
				await this.users.orgs.collectionDelete(_id);
			
		});
		
		
		/* Roles */
		
		this.wss.onRequest("users.roles.check-id", (wssc, _id: string) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users")) {
				if (!regexps.role.test(_id))
					throw new Err("Role ID is incorrect", "notroleid");
				
				if (this.users.roles.has(_id))
					throw new Err("Role ID already exists", "exists");
			}
			
		});
		
		this.wss.onRequest("users.roles.add", async (wssc, role: Omit<RoleDoc, "abilities" | "createdAt">) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users"))
				await this.users.roles.new(role);
			
		});
		
		this.wss.onRequest("users.roles.update", async (wssc, _id: string, { abilities, ...updates }: Omit<RoleDoc, "createdAt">) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.slaveRoleIds.includes(_id)) {
				if (updates.involves)
					if (includesAll(wssc.user.slaveRoleIds, updates.involves)) {
						removeAll(updates.involves, [ _id ]);
						
						const role = this.users.roles.get(_id);
						if (role)
							for (const involvedRoleId of updates.involves)
								if (this.users.roles.get(involvedRoleId)?.involves.has(role))
									removeAll(updates.involves, [ involvedRoleId ]);
						
						updates.involves = this.users.roles.cleanUpIds(updates.involves);
					} else
						throw new Err("Can't assign role the user is not involved in", "forbiddenrole");
				
				await this.users.roles.collection.updateOne({ _id }, { $set: updates });
			}
			
		});
		
		this.wss.onRequest("users.roles.set-ability", async (wssc, _id: string, abilityId: StringKey<Abilities<AS>>, paramId: string, value: unknown) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.slaveRoleIds.includes(_id) && wssc.user.abilities[abilityId]) {
				const role = this.users.roles.get(_id);
				if (role) {
					const abilities = structuredClone(role.ownAbilities) as GenericAbilities;
					let shouldUpdate;
					
					if (paramId) {
						if (!abilities[abilityId])
							abilities[abilityId] = {};
						const param = this.users.abilitiesMap.get(abilityId)?.params?.find(anotherParam => anotherParam._id === paramId);
						if (param) {
							const userAbilityWithParams = wssc.user.abilities[abilityId] as AbilityWithParams;
							const abilityWithParams = abilities[abilityId] as AbilityWithParams;
							if (param.type === "number") {
								if ((userAbilityWithParams[paramId] as AbilityParamNumber) >= (value as number)) {
									abilityWithParams[paramId] = value as number;
									shouldUpdate = true;
								}
							} else if (param.type === "items" && userAbilityWithParams[paramId] && includesAll(userAbilityWithParams[paramId] as AbilityParamItems, value as string[])) {
								abilityWithParams[paramId] = value as string[];
								shouldUpdate = true;
							}
						}
					} else {
						if (value)
							abilities[abilityId] = this.users.abilitiesMap.getMinimumOf(abilityId);
						else
							(function resolve(schema) {
								if (schema) {
									delete abilities[schema._id];
									if (schema.subAbilities)
										for (const subSchema of schema.subAbilities)
											if (abilities[subSchema._id])
												resolve(subSchema);
								}
								
							})(this.users.abilitiesMap.get(abilityId));
						
						shouldUpdate = true;
					}
					
					if (shouldUpdate)
						await this.users.roles.collection.updateOne({ _id }, { $set: { abilities } });
				}
			}
			
		});
		
		this.wss.on("client-message:users.roles.delete", async (wssc: WSSCWithUser<AS>, _id: string) => {
			if (wssc.user?.abilities.inSite?.sections?.includes("users") && wssc.user.slaveRoleIds.includes(_id))
				await this.users.roles.collectionDelete(_id);
			
		});
		
		return this;
	};
	
	private initPromise;
	
	whenReady() {
		return this.initPromise;
	}
	
	getDefaultSessionProps({ userAgent, remoteAddress }: WSSCWithUser<AS>) {
		return {
			userAgent,
			remoteAddress
		};
	}
	
	setSession(wssc: WSSCWithUser<AS>, session: null | Session<AS> | string | undefined, shouldProlong?: boolean) {
		if (session === null)
			session = undefined;
		else if (typeof session == "string")
			session = this.users.sessions.get(session);
		
		if (wssc.session !== session) {
			if (wssc.session)
				this.sessionsWsMap.delete(wssc.session);
			
			if (session) {
				wssc.session = session;
				wssc.user = session.user;
				wssc.lastUserId = session.user._id;
				
				this.userWsMap.get(session.user)?.add(wssc);
				this.sessionsWsMap.set(session, wssc);
				
				if (shouldProlong)
					session.prolong({
						...this.getDefaultSessionProps(wssc),
						...this.getSessionProps?.(wssc),
						isOnline: true
					});
				
			} else {
				delete wssc.session;
				delete wssc.user;
				
				this.userWsMap.get(wssc.user!)?.delete(wssc);
			}
			
			this.wss.emit("client-session", wssc, shouldProlong);
		}
		
	}
	
	private login = async (wssc: WSSCWithUser<AS>, email: string, password: string) => {
		const session = await this.users.login(email, password, {
			...this.getDefaultSessionProps(wssc),
			...this.getSessionProps?.(wssc),
			isOnline: true
		});
		
		if (session)
			this.setSession(wssc, session);
		
	};
	
	private logout = (wssc: WSSCWithUser<AS>) => {
		if (wssc.session) {
			this.users.logout(wssc.session);
			this.setSession(wssc, null);
		}
		
	};
	
	private handleRolesUpdate = () =>
		this.rolesPublication.flushInitial();
	
	private handleRolesRoleUpdate = (role: Role<AS>, next: ChangeStreamDocument<RoleDoc>) =>
		next && this.rolesPublication.skip(next);
	
	private handleUserCreate = (user: User<AS>) =>
		this.userWsMap.set(user, new Set<WSSCWithUser<AS>>());
	
	private handleUserIsOnline = ({ _id, isOnline }: User<AS>) => {
		const updates = { _id, isOnline };
		
		for (const usersSubscription of this.usersPublication.subscriptions) {
			const [ wssc ] = usersSubscription.args;
			if (wssc.user && wssc.user._id !== _id)
				usersSubscription.handler([ [ "u"/* update */, updates, true ] ]);
		}
		
	};
	
	private handleSessionDelete = (session: Session<AS>) => {
		const wssc = this.sessionsWsMap.get(session);
		
		if (wssc)
			this.setSession(wssc, null);
		
	};
	
	private handleOrgsUpdate = () => {
		
		this.orgsPublication.flushInitial();
		this.orgsExtendedPublication.flushInitial();
		
	};
	
	private handleOrgsOrgUpdate = (org: Org<AS>, next: ChangeStreamDocument<OrgDoc>) => {
		if (next) {
			this.orgsPublication.skip(next);
			this.orgsExtendedPublication.skip(next);
		}
		
	};
	
	private handleUserPermissionsChange = (user: User<AS>) => {
		const webSockets = this.userWsMap.get(user);
		
		if (webSockets)
			this.wss.emit("should-renew-subscriptions", [ ...webSockets ]);
		
	};
	
	private handleClientRequestLogin = (wssc: WSSCWithUser<AS>, email: string, password: string) =>
		this.login(wssc, email, password);
	
	private handleClientRequestLogout = (wssc: WSSCWithUser<AS>) =>
		this.logout(wssc);
	
	private handleClientClosed = (wssc: WSSCWithUser<AS>) => {
		wssc.session?.offline();
		this.setSession(wssc, null);
		
	};
	
	
	static init<IAS extends AbilitiesSchema>(options: Options<IAS>) {
		const usersServer = new UsersServer(options);
		
		return usersServer.whenReady();
	}
	
}
