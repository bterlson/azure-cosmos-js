﻿import * as assert from "assert";
import * as sinon from "sinon";
import { Base, Constants, CosmosClient, IHeaders } from "../../";
import { ConsistencyLevel, PartitionKind } from "../../documents";
import testConfig from "./../common/_testConfig";
import { TestHelpers } from "./../common/TestHelpers";

const endpoint = testConfig.host;
const masterKey = testConfig.masterKey;

// TODO: there is alot of "any" types for tokens here
// TODO: there is alot of leaky document client stuff here that will make removing document client hard

describe("Session Token", function () {
    this.timeout(10000);
    const client = new CosmosClient({ endpoint, auth: { masterKey }, consistencyLevel: ConsistencyLevel.Session });
    const databaseId = "sessionTestDB";
    const collectionId = "sessionTestColl";
    const collectionLink = "dbs/" + databaseId + "/colls/" + collectionId;

    const databaseBody = { id: databaseId };
    const containerDefinition = { id: collectionId, partitionKey: { paths: ["/id"], kind: PartitionKind.Hash } };
    const collectionOptions = { offerThroughput: 10100 };

    const getSpy = sinon.spy(client.documentClient, "get");
    const postSpy = sinon.spy(client.documentClient, "post");
    const putSpy = sinon.spy(client.documentClient, "put");
    const deleteSpy = sinon.spy(client.documentClient, "delete");

    const getToken = function (tokens: any) {
        const newToken: any = {};
        for (const coll in tokens) {
            if (tokens.hasOwnProperty(coll)) {
                for (const k in tokens[coll]) {
                    if (tokens[coll].hasOwnProperty(k)) {
                        newToken[k] = tokens[coll][k];
                    }
                }
                return newToken;
            }
        }
    };

    const getIndex = function (tokens: any, index1?: any) {
        const keys = Object.keys(tokens);
        if (typeof index1 === "undefined") {
            return keys[0];
        } else {
            return keys[1];
        }
    };

    afterEach(async function () { await TestHelpers.removeAllDatabases(client); });
    beforeEach(async function () { await TestHelpers.removeAllDatabases(client); });

    it("validate session tokens for sequence of opearations", async function () {
        let index1;
        let index2;

        const { result: databaseDef } = await client.databases.create(databaseBody);
        const database = client.databases.getDatabase(databaseDef.id);

        const { result: createdContainerDef } =
            await database.containers.create(containerDefinition, collectionOptions);
        const container = database.containers.getContainer(createdContainerDef.id);
        assert.equal(postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken], undefined);
        // TODO: testing implementation detail by looking at collectionResourceIdToSesssionTokens
        assert.deepEqual(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens, {});

        const { result: document1 } = await container.items.create({ id: "1" });
        assert.equal(postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken], undefined);

        let tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
        index1 = getIndex(tokens);
        assert.notEqual(tokens[index1], undefined);
        let firstPartitionLSN = tokens[index1];

        const { result: document2 } = await container.items.create({ id: "2" });
        assert.equal(postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
            client.documentClient.sessionContainer.getCombinedSessionToken(tokens));

        tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
        index2 = getIndex(tokens, index1);
        assert.equal(tokens[index1], firstPartitionLSN);
        assert.notEqual(tokens[index2], undefined);
        let secondPartitionLSN = tokens[index2];

        const { result: document12 } = await container.items.getItem(document1.id, "1").read();
        assert.equal(getSpy.lastCall.args[2][Constants.HttpHeaders.SessionToken],
            client.documentClient.sessionContainer.getCombinedSessionToken(tokens));
        tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
        assert.equal(tokens[index1], firstPartitionLSN);
        assert.equal(tokens[index2], secondPartitionLSN);

        const { result: document13 } =
            await container.items.upsert({ id: "1", operation: "upsert" }, { partitionKey: "1" });
        assert.equal(postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
            client.documentClient.sessionContainer.getCombinedSessionToken(tokens));
        tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
        assert.equal(tokens[index1], (Number(firstPartitionLSN) + 1).toString());
        assert.equal(tokens[index2], secondPartitionLSN);
        firstPartitionLSN = tokens[index1];

        const { result: document22 } = await container.items.getItem(document2.id, "2").delete();
        assert.equal(deleteSpy.lastCall.args[2][Constants.HttpHeaders.SessionToken],
            client.documentClient.sessionContainer.getCombinedSessionToken(tokens));
        tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
        assert.equal(tokens[index1], firstPartitionLSN);
        assert.equal(tokens[index2], (Number(secondPartitionLSN) + 1).toString());
        secondPartitionLSN = tokens[index2];

        const { result: document14 } =
            await container.items.getItem(document13.id)
                .replace({ id: "1", operation: "replace" }, { partitionKey: "1" });
        assert.equal(putSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
            client.documentClient.sessionContainer.getCombinedSessionToken(tokens));
        tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
        assert.equal(tokens[index1], (Number(firstPartitionLSN) + 1).toString());
        assert.equal(tokens[index2], secondPartitionLSN);
        firstPartitionLSN = tokens[index1];

        const query = "SELECT * from " + collectionId;
        const queryOptions = { partitionKey: "1" };
        const queryIterator = container.items.query(query, queryOptions);

        const { result } = await queryIterator.toArray();
        assert.equal(postSpy.lastCall.args[3][Constants.HttpHeaders.SessionToken],
            client.documentClient.sessionContainer.getCombinedSessionToken(tokens));
        tokens = getToken(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens);
        assert.equal(tokens[index1], firstPartitionLSN);
        assert.equal(tokens[index2], secondPartitionLSN);

        await container.delete();
        assert.equal(deleteSpy.lastCall.args[2][Constants.HttpHeaders.SessionToken],
            client.documentClient.sessionContainer.getCombinedSessionToken(tokens));
        assert.deepEqual(client.documentClient.sessionContainer.collectionResourceIdToSessionTokens, {});

        getSpy.restore();
        postSpy.restore();
        deleteSpy.restore();
        putSpy.restore();
    });

    it("validate 'lsn not caught up' error for higher lsn and clearing session token", async function () {
        const { result: databaseDef } = await client.databases.create(databaseBody);
        const database = client.databases.getDatabase(databaseDef.id);
        const increaseLSN = function (oldTokens: any) {
            for (const coll in oldTokens) {
                if (oldTokens.hasOwnProperty(coll)) {
                    for (const token in oldTokens[coll]) {
                        if (oldTokens[coll].hasOwnProperty(token)) {
                            const newVal = (Number(oldTokens[coll][token]) + 2000).toString();
                            return token + ":" + newVal;
                        }
                    }
                }
            }
        };

        await database.containers.create(containerDefinition, collectionOptions);
        const container = database.containers.getContainer(containerDefinition.id);
        await container.items.create({ id: "1" });
        const callbackSpy = sinon.spy(function (pat: string, reqHeaders: IHeaders) {
            const oldTokens = client.documentClient.sessionContainer.collectionResourceIdToSessionTokens;
            reqHeaders[Constants.HttpHeaders.SessionToken] = increaseLSN(oldTokens);
        });
        const applySessionTokenStub = sinon.stub(client.documentClient, "applySessionToken").callsFake(callbackSpy);
        try {
            const { result: document11 } =
                await container.items.getItem("1").read({ partitionKey: "1" });
            assert.fail("readDocument must throw");
        } catch (err) {
            assert.equal(err.substatus, 1002, "Substatus should indicate the LSN didn't catchup.");
            assert.equal(callbackSpy.callCount, 1);
            assert.equal(Base._trimSlashes(callbackSpy.lastCall.args[0]), collectionLink + "/docs/1");
            applySessionTokenStub.restore();
        }
        await container.items.getItem("1").read({ partitionKey: "1" });
    });

    it("client should not have session token of a collection created by another client", async function () {
        const client2 = new CosmosClient({ endpoint, auth: { masterKey }, consistencyLevel: ConsistencyLevel.Session });

        const { result: databaseDef } = await client.databases.create(databaseBody);
        const database = client.databases.getDatabase(databaseDef.id);
        await database.containers.create(containerDefinition, collectionOptions);
        const container = database.containers.getContainer(containerDefinition.id);
        await container.read();
        await client2.databases.getDatabase(databaseDef.id)
            .containers.getContainer(containerDefinition.id)
            .delete();

        const { result: createdCollection2 } =
        await client2.databases.getDatabase(databaseDef.id)
            .containers.create(containerDefinition, collectionOptions);

        const { result: collection2 } = await client2.databases.getDatabase(databaseDef.id)
            .containers.getContainer(containerDefinition.id)
            .read();
        assert.equal(client.documentClient.getSessionToken((collection2 as any)._self), ""); // TODO: _self
        assert.notEqual(client2.documentClient.getSessionToken((collection2 as any)._self), "");
    });
});
