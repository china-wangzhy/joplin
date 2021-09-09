import Logger from '../../Logger';
import BaseItem from '../../models/BaseItem';
import MasterKey from '../../models/MasterKey';
import Setting from '../../models/Setting';
import { MasterKeyEntity } from './types';
import EncryptionService from './EncryptionService';
import { getActiveMasterKey, getActiveMasterKeyId, localSyncInfo, masterKeyEnabled, saveLocalSyncInfo, setEncryptionEnabled, SyncInfo } from '../synchronizer/syncInfoUtils';
import JoplinError from '../../JoplinError';
import { pkReencryptPrivateKey, ppkPasswordIsValid } from './ppk';

const logger = Logger.create('e2ee/utils');

export async function setupAndEnableEncryption(service: EncryptionService, masterKey: MasterKeyEntity = null, masterPassword: string = null) {
	if (!masterKey) {
		// May happen for example if there are master keys in info.json but none
		// of them is set as active. But in fact, unless there is a bug in the
		// application, this shouldn't happen.
		logger.warn('Setting up E2EE without a master key - user will need to either generate one or select one of the existing ones as active');
	}

	setEncryptionEnabled(true, masterKey ? masterKey.id : null);

	if (masterPassword) {
		Setting.setValue('encryption.masterPassword', masterPassword);
	}

	// Mark only the non-encrypted ones for sync since, if there are encrypted ones,
	// it means they come from the sync target and are already encrypted over there.
	await BaseItem.markAllNonEncryptedForSync();

	await loadMasterKeysFromSettings(service);
}

export async function setupAndDisableEncryption(service: EncryptionService) {
	// Allow disabling encryption even if some items are still encrypted, because whether E2EE is enabled or disabled
	// should not affect whether items will enventually be decrypted or not (DecryptionWorker will still work as
	// long as there are encrypted items). Also even if decryption is disabled, it's possible that encrypted items
	// will still be received via synchronisation.

	setEncryptionEnabled(false);

	// The only way to make sure everything gets decrypted on the sync target is
	// to re-sync everything.
	await BaseItem.forceSyncAll();

	await loadMasterKeysFromSettings(service);
}

export async function toggleAndSetupEncryption(service: EncryptionService, enabled: boolean, masterKey: MasterKeyEntity, password: string) {
	logger.info('toggleAndSetupEncryption: enabled:', enabled, ' Master key', masterKey);

	if (!enabled) {
		await setupAndDisableEncryption(service);
	} else {
		if (masterKey) {
			await setupAndEnableEncryption(service, masterKey, password);
		} else {
			await generateMasterKeyAndEnableEncryption(EncryptionService.instance(), password);
		}
	}

	await loadMasterKeysFromSettings(service);
}

export async function generateMasterKeyAndEnableEncryption(service: EncryptionService, password: string) {
	let masterKey = await service.generateMasterKey(password);
	masterKey = await MasterKey.save(masterKey);
	await setupAndEnableEncryption(service, masterKey, password);
	await loadMasterKeysFromSettings(service);
	return masterKey;
}

// Migration function to initialise the master password. Normally it is set when
// enabling E2EE, but previously it wasn't. So here we check if the password is
// set. If it is not, we set it from the active master key. It needs to be
// called after the settings have been initialized.
export async function migrateMasterPassword() {
	// Already migrated
	if (Setting.value('encryption.masterPassword')) return;

	// If a PPK is defined it means the master password has been set at some
	// point so no need to run the migration
	if (localSyncInfo().ppk) return;

	logger.info('Master password is not set - trying to get it from the active master key...');

	const mk = getActiveMasterKey();
	if (!mk) return;

	const masterPassword = Setting.value('encryption.passwordCache')[mk.id];
	if (masterPassword) {
		Setting.setValue('encryption.masterPassword', masterPassword);
		logger.info('Master password is now set.');

		// Also clear the key passwords that match the master password to avoid
		// any confusion.
		const cache = Setting.value('encryption.passwordCache');
		const newCache = { ...cache };
		for (const [mkId, password] of Object.entries(cache)) {
			if (password === masterPassword) {
				delete newCache[mkId];
			}
		}
		Setting.setValue('encryption.passwordCache', newCache);
		await Setting.saveAll();
	}
}

// All master keys normally should be decryped with the master password, however
// previously any master key could be encrypted with any password, so to support
// this legacy case, we first check if the MK decrypts with the master password.
// If not, try with the master key specific password, if any is defined.
export async function findMasterKeyPassword(service: EncryptionService, masterKey: MasterKeyEntity): Promise<string> {
	const masterPassword = Setting.value('encryption.masterPassword');
	if (masterPassword && await service.checkMasterKeyPassword(masterKey, masterPassword)) {
		logger.info('findMasterKeyPassword: Using master password');
		return masterPassword;
	}

	logger.info('findMasterKeyPassword: No master password is defined - trying to get master key specific password');

	const passwords = Setting.value('encryption.passwordCache');
	return passwords[masterKey.id];
}

export async function loadMasterKeysFromSettings(service: EncryptionService) {
	const masterKeys = await MasterKey.all();
	const activeMasterKeyId = getActiveMasterKeyId();

	logger.info(`Trying to load ${masterKeys.length} master keys...`);

	for (let i = 0; i < masterKeys.length; i++) {
		const mk = masterKeys[i];
		if (service.isMasterKeyLoaded(mk)) continue;

		const password = await findMasterKeyPassword(service, mk);
		if (!password) continue;

		try {
			await service.loadMasterKey(mk, password, activeMasterKeyId === mk.id);
		} catch (error) {
			logger.warn(`Cannot load master key ${mk.id}. Invalid password?`, error);
		}
	}

	logger.info(`Loaded master keys: ${service.loadedMasterKeysCount()}`);
}

export function showMissingMasterKeyMessage(syncInfo: SyncInfo, notLoadedMasterKeys: string[]) {
	if (!syncInfo.masterKeys.length) return false;

	notLoadedMasterKeys = notLoadedMasterKeys.slice();

	for (let i = notLoadedMasterKeys.length - 1; i >= 0; i--) {
		const mk = syncInfo.masterKeys.find(mk => mk.id === notLoadedMasterKeys[i]);

		// A "notLoadedMasterKey" is a key that either doesn't exist or for
		// which a password hasn't been set yet. For the purpose of this
		// function, we only want to notify the user about unset passwords.
		// Master keys that haven't been downloaded yet should normally be
		// downloaded at some point.
		// https://github.com/laurent22/joplin/issues/5391
		if (!mk) continue;
		if (!masterKeyEnabled(mk)) notLoadedMasterKeys.pop();
	}

	return !!notLoadedMasterKeys.length;
}

export function getDefaultMasterKey(): MasterKeyEntity {
	const mk = getActiveMasterKey();
	if (mk) return mk;
	return MasterKey.latest();
}

// Get the master password if set, or throw an exception. This ensures that
// things aren't accidentally encrypted with an empty string. Calling code
// should look for "undefinedMasterPassword" code and prompt for password.
export function getMasterPassword(throwIfNotSet: boolean = true): string {
	const password = Setting.value('encryption.masterPassword');
	if (!password && throwIfNotSet) throw new JoplinError('Master password is not set', 'undefinedMasterPassword');
	return password;
}

export async function updateMasterPassword(currentPassword: string, newPassword: string, waitForSyncFinishedThenSync: Function = null) {
	if (localSyncInfo().ppk || localSyncInfo().masterKeys?.length) {
		if (!currentPassword) throw new Error('Previous password must be provided in order to reencrypt the encryption keys');

		const reencryptedMasterKeys: MasterKeyEntity[] = [];
		let reencryptedPpk = null;

		for (const mk of localSyncInfo().masterKeys) {
			try {
				reencryptedMasterKeys.push(await EncryptionService.instance().reencryptMasterKey(mk, currentPassword, newPassword));
			} catch (error) {
				error.message = `Master key ${mk.id} could not be reencrypted - this is most likely due to an incorrect password. Please try again. Error was: ${error.message}`;
				throw error;
			}
		}

		if (localSyncInfo().ppk) {
			try {
				reencryptedPpk = await pkReencryptPrivateKey(EncryptionService.instance(), localSyncInfo().ppk, currentPassword, newPassword);
			} catch (error) {
				error.message = `Private key could not be reencrypted - this is most likely due to an incorrect password. Please try again. Error was: ${error.message}`;
				throw error;
			}
		}

		for (const mk of reencryptedMasterKeys) {
			await MasterKey.save(mk);
		}

		if (reencryptedPpk) {
			const syncInfo = localSyncInfo();
			syncInfo.ppk = reencryptedPpk;
			saveLocalSyncInfo(syncInfo);
		}
	}

	Setting.setValue('encryption.masterPassword', newPassword);

	if (waitForSyncFinishedThenSync) void waitForSyncFinishedThenSync();
}

export enum MasterPasswordStatus {
	Unknown = 0,
	Loaded = 1,
	NotSet = 2,
	Invalid = 3,
	Valid = 4,
}

export async function getMasterPasswordStatus(): Promise<MasterPasswordStatus> {
	const password = getMasterPassword(false);
	if (!password) return MasterPasswordStatus.NotSet;

	try {
		const isValid = await masterPasswordIsValid(password);
		return isValid ? MasterPasswordStatus.Valid : MasterPasswordStatus.Invalid;
	} catch (error) {
		if (error.code === 'noKeyToDecrypt') return MasterPasswordStatus.Loaded;
		throw error;
	}
}

const masterPasswordStatusMessages = {
	[MasterPasswordStatus.Unknown]: 'Checking...',
	[MasterPasswordStatus.Loaded]: 'Loaded',
	[MasterPasswordStatus.NotSet]: 'Not set',
	[MasterPasswordStatus.Valid]: '✓ ' + 'Valid',
	[MasterPasswordStatus.Invalid]: '❌ ' + 'Invalid',
};

export function getMasterPasswordStatusMessage(status: MasterPasswordStatus): string {
	return masterPasswordStatusMessages[status];
}

export async function masterPasswordIsValid(masterPassword: string): Promise<boolean> {
	// A valid password is basically one that decrypts the private key, but due
	// to backward compatibility not all users have a PPK yet, so we also check
	// based on the active master key.

	const ppk = localSyncInfo().ppk;
	if (ppk) {
		return ppkPasswordIsValid(EncryptionService.instance(), ppk, masterPassword);
	}

	const masterKey = getDefaultMasterKey();
	if (masterKey) {
		return EncryptionService.instance().checkMasterKeyPassword(masterKey, masterPassword);
	}

	throw new JoplinError('Cannot check master password validity as no key is present', 'noKeyToDecrypt');
}
