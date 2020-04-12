/**
 * Full documentation for the "identitytoolkit" API can be found here:
 * https://cloud.google.com/identity-platform/docs/reference/rest/v1/accounts
 */
import humanReadableErrors from './errors.json';

/**
 * Settings object for an IDP(Identity Provider).
 * @typedef {Object} ProviderOptions
 * @property {string} options.name The name of the provider in lowercase.
 * @property {string} [options.scope] The scopes for the IDP, this is optional and defaults to "openid email".
 */

/**
 * Object response from a "fetchProvidersForEmail" request.
 * @typedef {Object} ProvidersForEmailResponse
 * @property {Array.<string>} allProviders All providers the user has once used to do federated login
 * @property {boolean} registered All sign-in methods this user has used.
 * @property {string} sessionId Session ID which should be passed in the following verifyAssertion request
 * @property {Array.<string>} signinMethods All sign-in methods this user has used.
 */

/**
 * Setting object for the "startOauthFlow" method.
 * @typedef {Object} oauthFlowOptions
 * @property {string} provider Name of the provider to use.
 * @property {string} [context] A string that will be returned after the Oauth flow is finished, should be used to retain context.
 * @property {boolean} [linkAccount = false] Whether to link this oauth account with the current account. defaults to false.
 */

// Generate a local storage adapter.
// Its a bit verbose, but takes less characters than writing it manually.
const localStorageAdapter = {};
['set', 'get', 'remove'].forEach(m => (localStorageAdapter[m] = async (k, v) => localStorage[m + 'Item'](k, v)));

/**
 * Encapsulates authentication flow logic.
 * @param {Object} options Options object.
 * @param {string} options.apiKey The firebase API key
 * @param {string} options.redirectUri The redirect URL used by OAuth providers.
 * @param {Array.<ProviderOptions|string>} options.providers Array of arguments that will be passed to the addProvider method.
 */
export default class Auth {
	constructor({ name = 'default', apiKey, redirectUri, providers = [], storage = localStorageAdapter } = {}) {
		if (typeof apiKey !== 'string') throw Error('The argument "apiKey" is required');
		if (!Array.isArray(providers)) throw Error('The argument "providers" must be an array');

		Object.assign(this, {
			name,
			apiKey,
			storage,
			redirectUri,
			providers: {},
			listeners: []
		});

		for (const options of providers) {
			const { name, scope } = typeof options === 'string' ? { name: options } : options;
			this.providers[name] = scope;
		}

		this.storage.get(`Auth:User:${apiKey}:${name}`).then(user => {
			if (user) {
				this.user = JSON.parse(user);
				this.fetchProfile();
			}
		});
	}

	/**
	 * Emits an event and triggers all of the listeners.
	 * @param {string} name The name of the event to trigger.
	 * @param {any} data The data you want to pass to the event listeners.
	 * @private
	 */
	emit() {
		this.listeners.forEach(cb => cb(this.user));
	}

	/**
	 * Set up a function that will be called whenever the user state is changed.
	 * @param {function} cb The function to call when the event is triggered.
	 * @returns {function} function that will unsubscribe your callback from being called.
	 */
	listen(cb) {
		this.listeners.push(cb);

		// Return a function to unbind the callback.
		return () => (this.listeners = this.listeners.filter(fn => fn !== cb));
	}

	/**
	 * Make post request to a specific endpoint, and return the response.
	 * @param {string} endpoint The name of the endpoint.
	 * @param {any} request Body to pass to the request.
	 * @private
	 */
	api(endpoint, body) {
		const url =
			endpoint === 'token'
				? `https://securetoken.googleapis.com/v1/token?key=${this.apiKey}`
				: `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${this.apiKey}`;

		return fetch(url, {
			method: 'POST',
			body: typeof body === 'string' ? body : JSON.stringify(body)
		}).then(async response => {
			let data = await response.json();

			// If the response has an error, check to see if we have a human readable version of it,
			// and throw that instead.
			if (!response.ok) {
				throw Error(humanReadableErrors[data.error.message] || data.error.message);
			}

			// Add a hidden date property to the returned object.
			// Used mostly to calculate the expiration date for tokens.
			Object.defineProperty(data, 'expiresAt', { value: Date.parse(response.headers.get('date')) + 3600 * 1000 });
			return data;
		});
	}

	/**
	 * Makes sure the user is logged in and has up-to-date credentials.
	 * @throws Will throw if the user is not logged in.
	 * @private
	 */
	async enforceAuth() {
		if (!this.user) throw Error('The user must be logged-in to use this method.');
		return this.refreshIdToken(); // Won't do anything if the token is valid.
	}

	/**
	 * Saves the user data in the local storage.
	 * @param {Object} credentials
	 * @private
	 */
	async persistSession(userData) {
		// Persist the session to the local storage.
		await this.storage.set(`Auth:User:${this.apiKey}:${this.name}`, JSON.stringify(userData));
		this.user = userData;
		this.emit();
	}

	/**
	 * Sign out the currently signed in user.
	 * Removes all data stored in the storage that's associated with the user.
	 */
	async signOut() {
		await this.storage.remove(`Auth:User:${this.apiKey}:${this.name}`);
		this.user = null;
		this.emit();
	}

	/**
	 * Refreshes the idToken by using the locally stored refresh token
	 * only if the idToken has expired.
	 * @private
	 */
	async refreshIdToken() {
		// If the idToken didn't expire, return.
		if (Date.now() < this.user.tokenManager.expiresAt) return;

		// If a request for a new token was already made, then wait for it and then return.
		if (this.refreshRequest) {
			return await this.refreshRequest;
		}

		try {
			// Save the promise so that if this function is called
			// anywhere else we don't make more than one request.
			this.refreshRequest = this.api('token', {
				grant_type: 'refresh_token',
				refresh_token: this.user.tokenManager.refreshToken
			});

			const { id_token: idToken, refresh_token: refreshToken, expiresAt } = await this.refreshRequest;

			await this.persistSession({
				...this.user,
				// Rename the data names to match the ones used in the app.
				tokenManager: { idToken, refreshToken, expiresAt }
			});
		} finally {
			this.refreshRequest = null;
		}
	}

	/**
	 * Uses native fetch, but adds authorization headers otherwise the API is exactly the same as native fetch.
	 * @param {Request|Object|string} resource the resource to send the request to, or an options object.
	 * @param {Object} init an options object.
	 */
	async authorizedRequest(resource, init) {
		const request = resource instanceof Request ? resource : new Request(resource, init);

		if (this.user) {
			await this.refreshIdToken(); // Won't do anything if the token didn't expire yet.
			request.headers.set('Authorization', `Bearer ${this.user.tokenManager.idToken}`);
		}

		return fetch(request);
	}

	/**
	 * Signs in or signs up a user by exchanging a custom Auth token.
	 * @param {string} token The custom token.
	 */
	async signInWithCustomToken(token) {
		// Try to exchange the Auth Code for an idToken and refreshToken.
		const { idToken, refreshToken, expiresAt } = await this.api('signInWithCustomToken', {
			token,
			returnSecureToken: true
		});

		// Now get the user profile.
		await this.fetchProfile({ idToken, refreshToken, expiresAt });
	}

	/**
	 * Start auth flow of a federated Id provider.
	 * Will redirect the page to the federated login page.
	 * @param {oauthFlowOptions|string} options An options object, or a string with the name of the provider.
	 */
	async signInWithProvider(options) {
		if (!this.redirectUri)
			throw Error('In order to use an Identity provider you should initiate the "Auth" instance with a "redirectUri".');

		// The options can be a string, or an object, so here we make sure we extract the right data in each case.
		const { provider, context, linkAccount } = typeof options === 'string' ? { provider: options } : options;

		// Make sure the user is logged in when an "account link" was requested.
		if (linkAccount) await this.enforceAuth();

		// Get an array of the allowed providers names.
		const allowedProviders = Object.keys(this.providers);

		// Verify that the requested provider is indeed configured.
		if (!allowedProviders.includes(provider))
			throw Error(`You haven't configured "${provider}" with this "Auth" instance.`);

		// Get the url and other data necessary for the authentication.
		const { authUri, sessionId } = await this.api('createAuthUri', {
			providerId: provider,
			continueUri: this.redirectUri,
			oauthScope: this.providers[provider],
			authFlowType: 'CODE_FLOW',
			context
		});

		// Save the sessionId that we just received in the local storage.
		// Is required to finish the auth flow, I believe this is used to mitigate CSRF attacks.
		// (No docs on this...)
		await this.storage.set(`Auth:SessionId:${this.apiKey}:${this.name}`, sessionId);
		// Save if this is a fresh log-in or a "link account" request.
		linkAccount && (await this.storage.set(`Auth:LinkAccount:${this.apiKey}:${this.name}`, true));

		// Finally - redirect the page to the auth endpoint.
		location.assign(authUri);
	}

	/**
	 * Signs in or signs up a user using credentials from an Identity Provider (IdP) after a redirect.
	 * Will fail silently if the URL doesn't have a "code" search param.
	 * @param {string} [requestUri] The request URI with the authorization code, state etc. from the IdP.
	 * @private
	 */
	async finishProviderSignIn(requestUri = location.href) {
		// Get the sessionId we received before the redirect from storage.
		const sessionId = await this.storage.get(`Auth:SessionId:${this.apiKey}:${this.name}`);
		// Get the indication if this was a "link account" request.
		const linkAccount = await this.storage.get(`Auth:LinkAccount:${this.apiKey}:${this.name}`);
		// Check for the edge case in which the user signed out before completing the linkAccount
		// Request.
		if (linkAccount && !this.user) throw Error('Request to "Link account" was made, but user is no longer signed-in');
		await this.storage.remove(`Auth:LinkAccount:${this.apiKey}:${this.name}`);

		// Try to exchange the Auth Code for an idToken and refreshToken.
		const { idToken, refreshToken, expiresAt, context } = await this.api('signInWithIdp', {
			// If this is a "link account" flow, then attach the idToken of the currently logged in account.
			idToken: linkAccount ? this.user.tokenManager.idToken : undefined,
			requestUri,
			sessionId,
			returnSecureToken: true
		});

		// Now get the user profile.
		await this.fetchProfile({ idToken, refreshToken, expiresAt });

		// Remove sensitive data from the URLSearch params in the location bar.
		history.replaceState(null, null, location.origin + location.pathname);

		return context;
	}

	/**
	 * Handles all sign in flows that complete via redirects.
	 * Fails silently if no redirect was detected.
	 */
	async handleSignInRedirect() {
		// Oauth Federated Identity Provider flow.
		if (location.href.match(/[&?]code=/)) return this.finishProviderSignIn();

		// Email Sign-in flow.
		if (location.href.match(/[&?]oobCode=/)) {
			const oobCode = location.href.match(/[?&]oobCode=([^&]+)/)[1];
			const email = location.href.match(/[?&]email=([^&]+)/)[1];
			const expiresAt = Date.now() + 3600 * 1000;
			const { idToken, refreshToken } = await this.api('signInWithEmailLink', { oobCode, email });
			// Now get the user profile.
			await this.fetchProfile({ idToken, refreshToken, expiresAt });
			// Remove sensitive data from the URLSearch params in the location bar.
			history.replaceState(null, null, location.origin + location.pathname);
		}
	}

	/**
	 * Signs up with email and password or anonymously when no arguments are passed.
	 * Automatically signs the user in on completion.
	 * @param {string} [email] The email for the user to create.
	 * @param {string} [password] The password for the user to create.
	 */
	async signUp(email, password) {
		const { idToken, refreshToken, expiresAt } = await this.api('signUp', {
			email,
			password,
			returnSecureToken: true
		});

		// Get the user profile and persists the session.
		await this.fetchProfile({ idToken, refreshToken, expiresAt });
	}

	/**
	 * Signs in a user with email and password.
	 * @param {string} email
	 * @param {string} password
	 */
	async signIn(email, password) {
		const { idToken, refreshToken, expiresAt } = await this.api('signInWithPassword', {
			email,
			password,
			returnSecureToken: true
		});

		// Get the user profile and persists the session.
		await this.fetchProfile({ idToken, refreshToken, expiresAt });
	}

	/**
	 * Sends an out-of-band confirmation code for an account.
	 * Can be used to reset a password, to verify an email address and send a Sign-in email link.
	 * The `email` argument is not needed only when verifying an email(In that case it will be completely ignored, even if specified), otherwise it is required.
	 * @param {'PASSWORD_RESET'|'VERIFY_EMAIL'|'EMAIL_SIGNIN'} requestType The type of out-of-band (OOB) code to send.
	 * @param {string} [email] When the `requestType` is `PASSWORD_RESET` or `EMAIL_SIGNIN` you need to provide an email address.
	 * @returns {Promise}
	 */
	async sendOobCode(requestType, email) {
		const verifyEmail = requestType === 'VERIFY_EMAIL';
		if (verifyEmail) {
			await this.enforceAuth();
			email = this.user.email;
		}

		return void this.api('sendOobCode', {
			idToken: verifyEmail ? this.user.tokenManager.idToken : undefined,
			requestType,
			email,
			continueUrl: this.redirectUri + `?email=${email}`
		});
	}

	/**
	 * Sets a new password by using a reset code.
	 * Can also be used to very oobCode by not passing a password.
	 * @param {string} code
	 * @returns {string} The email of the account to which the code was issued.
	 */
	async resetPassword(oobCode, newPassword) {
		return (await this.api('resetPassword', { oobCode, newPassword })).email;
	}

	/**
	 * Returns info about all providers associated with a specified email.
	 * @param {string} email The user's email address.
	 * @returns {ProvidersForEmailResponse}
	 */
	async fetchProvidersForEmail(email) {
		const response = await this.api('createAuthUri', { identifier: email, continueUri: location.href });
		delete response.kind;
		return response;
	}

	/**
	 * Gets the user data from the server, and updates the local caches.
	 * @param {Object} [tokenManager] Only when not logged in.
	 * @throws Will throw if the user is not signed in.
	 */
	async fetchProfile(tokenManager = this.user && this.user.tokenManager) {
		!this.user && !tokenManager && (await this.enforceAuth());

		const userData = (await this.api('lookup', { idToken: tokenManager.idToken })).users[0];

		delete userData.kind;
		userData.tokenManager = tokenManager;

		await this.persistSession(userData);
	}

	/**
	 * Update user's profile.
	 * @param {Object} newData An object with the new data to overwrite.
	 * @throws Will throw if the user is not signed in.
	 */
	async updateProfile(newData) {
		await this.enforceAuth();

		// Calculate the expiration date for the idToken.
		const updatedData = await this.api('update', {
			...newData,
			idToken: this.user.tokenManager.idToken,
			returnSecureToken: true
		});

		const { idToken, refreshToken, expiresAt } = updatedData;

		if (updatedData.idToken) {
			updatedData.tokenManager = { idToken, refreshToken, expiresAt };
		} else {
			updatedData.tokenManager = this.user.tokenManager;
		}

		delete updatedData.kind;
		delete updatedData.idToken;
		delete updatedData.refreshToken;

		await this.persistSession(updatedData);
	}

	/**
	 * Deletes the currently logged in account and logs out.
	 * @throws Will throw if the user is not signed in.
	 */
	async deleteAccount() {
		await this.enforceAuth();
		await this.api('delete', `{"idToken": "${this.user.tokenManager.idToken}"}`);
		this.signOut();
	}
}
