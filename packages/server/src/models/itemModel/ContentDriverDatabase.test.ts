import { clientType } from '../../db';
import { afterAllTests, beforeAllDb, beforeEachDb, db, expectNotThrow, expectThrow, models } from '../../utils/testing/testUtils';
import ContentDriverDatabase from './ContentDriverDatabase';
import { shouldDeleteContent, shouldNotCreateItemIfContentNotSaved, shouldNotUpdateItemIfContentNotSaved, shouldWriteToContentAndReadItBack } from './testUtils';

const newDriver = () => {
	return new ContentDriverDatabase({
		dbClientType: clientType(db()),
	});
};

describe('ContentDriverDatabase', function() {

	beforeAll(async () => {
		await beforeAllDb('ContentDriverDatabase');
	});

	afterAll(async () => {
		await afterAllTests();
	});

	beforeEach(async () => {
		await beforeEachDb();
	});

	test('should write to content and read it back', async function() {
		const driver = newDriver();
		await shouldWriteToContentAndReadItBack(driver);
	});

	test('should delete the content', async function() {
		const driver = newDriver();
		await shouldDeleteContent(driver);
	});

	test('should not create the item if the content cannot be saved', async function() {
		const driver = newDriver();
		await shouldNotCreateItemIfContentNotSaved(driver);
	});

	test('should not update the item if the content cannot be saved', async function() {
		const driver = newDriver();
		await shouldNotUpdateItemIfContentNotSaved(driver);
	});

	test('should fail if the item row does not exist', async function() {
		const driver = newDriver();
		await expectThrow(async () => driver.read('oops', { models: models() }));
	});

	test('should do nothing if deleting non-existing row', async function() {
		const driver = newDriver();
		await expectNotThrow(async () => driver.delete('oops', { models: models() }));
	});

});