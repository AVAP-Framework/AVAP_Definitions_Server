const logic = require('../src/logic');

// --- MOCK DATABASE ---
// We mock the DB so unit tests run without PostgreSQL
jest.mock('../src/db', () => ({
    query: jest.fn().mockResolvedValue({
        rows: [
            { 
                name: 'if', 
                type: 'statement', 
                interface: '[]', 
                code: Buffer.from('print("hello")') 
            }
        ]
    })
}));

describe('AVAP Logic Engine (Unit Tests)', () => {
    
    const API_KEY_BUFFER = Buffer.from('avap_secret_key_2026');

    // Before tests, we trigger the loadDefinitions to warm up the RAM cache
    beforeAll(async () => {
        await logic.loadDefinitions();
    });

    test('Should block access without Token', (done) => {
        const mockCall = {
            request: { name: 'if' },
            metadata: {
                // FIX: Simulate gRPC getMap function
                getMap: () => ({}) 
            }
        };

        const callback = (err, response) => {
            expect(err).toBeTruthy();
            expect(err.code).toBe(16); // UNAUTHENTICATED
            done();
        };

        logic.getCommandLogic(mockCall, callback, API_KEY_BUFFER);
    });

    test('Should block access with Invalid Token', (done) => {
        const mockCall = {
            request: { name: 'if' },
            metadata: {
                getMap: () => ({ 'x-avap-auth': 'WRONG_TOKEN' })
            }
        };

        const callback = (err, response) => {
            expect(err).toBeTruthy();
            expect(err.code).toBe(16); // UNAUTHENTICATED
            done();
        };

        logic.getCommandLogic(mockCall, callback, API_KEY_BUFFER);
    });

    test('Should allow access with Correct Token', (done) => {
        const mockCall = {
            request: { name: 'if' },
            metadata: {
                getMap: () => ({ 'x-avap-auth': 'avap_secret_key_2026' })
            }
        };

        const callback = (err, response) => {
            expect(err).toBeNull(); // No error
            expect(response).toBeTruthy();
            done();
        };

        logic.getCommandLogic(mockCall, callback, API_KEY_BUFFER);
    });

    test('Should return code if command exists (Cache Hit)', (done) => {
        const mockCall = {
            request: { name: 'if' },
            metadata: {
                getMap: () => ({ 'x-avap-auth': 'avap_secret_key_2026' })
            }
        };

        const callback = (err, response) => {
            expect(err).toBeNull();
            expect(response.name).toBe('if');
            expect(response.code).toBeInstanceOf(Buffer);
            done();
        };

        logic.getCommandLogic(mockCall, callback, API_KEY_BUFFER);
    });

    test('Should return 404 if command does NOT exist', (done) => {
        const mockCall = {
            request: { name: 'non_existent_command' },
            metadata: {
                getMap: () => ({ 'x-avap-auth': 'avap_secret_key_2026' })
            }
        };

        const callback = (err, response) => {
            expect(err).toBeTruthy();
            expect(err.code).toBe(5); // NOT_FOUND
            done();
        };

        logic.getCommandLogic(mockCall, callback, API_KEY_BUFFER);
    });
});