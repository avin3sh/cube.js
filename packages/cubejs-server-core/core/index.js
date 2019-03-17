/* eslint-disable global-require */
const ApiGateway = require('@cubejs-backend/api-gateway');
const fs = require('fs-extra');
const path = require('path');
const CompilerApi = require('./CompilerApi');
const OrchestratorApi = require('./OrchestratorApi');
const FileRepository = require('./FileRepository');

const DriverDependencies = {
  postgres: '@cubejs-backend/postgres-driver',
  mysql: '@cubejs-backend/mysql-driver',
  athena: '@cubejs-backend/athena-driver',
  jdbc: '@cubejs-backend/jdbc-driver',
  mongobi: '@cubejs-backend/mongobi-driver'
};

const checkEnvForPlaceholders = () => {
  const placeholderSubstr = '<YOUR_DB_';
  const credentials = [
    'CUBEJS_DB_HOST',
    'CUBEJS_DB_NAME',
    'CUBEJS_DB_USER',
    'CUBEJS_DB_PASS'
  ];
  if (
    credentials.find((credential) => (
      process.env[credential] && process.env[credential].indexOf(placeholderSubstr) === 0
    ))
  ) {
    throw new Error('Your .env file contains placeholders in DB credentials. Please replace them with your DB credentials.');
  }
};

class CubejsServerCore {
  constructor(options) {
    options = options || {};
    options = {
      driverFactory: () => CubejsServerCore.createDriver(options.dbType),
      apiSecret: process.env.CUBEJS_API_SECRET,
      dbType: process.env.CUBEJS_DB_TYPE,
      devServer: process.env.NODE_ENV !== 'production',
      ...options
    };
    if (
      !options.driverFactory ||
      !options.apiSecret ||
      !options.dbType
    ) {
      throw new Error('driverFactory, apiSecret, dbType are required options');
    }
    this.options = options;
    this.driverFactory = options.driverFactory;
    this.apiSecret = options.apiSecret;
    this.schemaPath = options.schemaPath || 'schema';
    this.dbType = options.dbType;
    this.logger = options.logger || ((msg, params) => { console.log(`${msg}: ${JSON.stringify(params)}`)});
    this.repository = new FileRepository(this.schemaPath);

    if (this.options.devServer) {
      const Analytics = require('analytics-node');
      const client = new Analytics('dSR8JiNYIGKyQHKid9OaLYugXLao18hA', { flushInterval: 100 });
      const { machineIdSync } = require('node-machine-id');
      const { promisify } = require('util');
      const anonymousId = machineIdSync();
      this.anonymousId = anonymousId;
      this.event = async (name, props) => {
        try {
          await promisify(client.track.bind(client))({
            event: name,
            anonymousId,
            properties: props
          });
          await promisify(client.flush.bind(client))();
        } catch (e) {
          // console.error(e);
        }
      };
      if (!options.logger) {
        this.logger = ((msg, params) => {
          if (
            msg === 'Load Request' ||
            msg === 'Load Request Success' ||
            msg === 'Orchestrator error' ||
            msg === 'Internal Server Error' ||
            msg === 'User Error'
          ) {
            this.event(msg, { error: params.error });
          }
          console.log(`${msg}: ${JSON.stringify(params)}`);
        });
      }
      let causeErrorPromise;
      process.on('uncaughtException', async (e) => {
        console.error(e.stack || e);
        if (e.message && e.message.indexOf('Redis connection to') !== -1) {
          console.log('🛑 Cube.js Server requires locally running Redis instance to connect to');
          if (process.platform.indexOf('win') === 0) {
            console.log('💾 To install Redis on Windows please use https://github.com/MicrosoftArchive/redis/releases');
          } else if (process.platform.indexOf('darwin') === 0) {
            console.log('💾 To install Redis on Mac please use https://redis.io/topics/quickstart or `$ brew install redis`');
          } else {
            console.log('💾 To install Redis please use https://redis.io/topics/quickstart');
          }
        }
        if (!causeErrorPromise) {
          causeErrorPromise = this.event('Dev Server Fatal Error', {
            error: (e.stack || e.message || e).toString()
          });
        }
        await causeErrorPromise;
        process.exit(1);
      });
    }
  }

  static create(options) {
    return new CubejsServerCore(options);
  }

  async initApp(app) {
    checkEnvForPlaceholders();
    this.compilerApi = this.createCompilerApi(this.repository);
    this.orchestratorApi = this.createOrchestratorApi();
    const apiGateway = new ApiGateway(
      this.apiSecret,
      this.compilerApi,
      this.orchestratorApi,
      this.logger, {
        checkAuthMiddleware: this.options.checkAuthMiddleware
      }
    );
    apiGateway.initApp(app);
    if (this.options.devServer) {
      this.initDevEnv(app);
    }
  }

  initDevEnv(app) {
    const port = process.env.PORT || 4000; // TODO
    const apiUrl = process.env.CUBEJS_API_URL || `http://localhost:${port}`;
    const jwt = require('jsonwebtoken');
    const cubejsToken = jwt.sign({}, this.apiSecret, { expiresIn: '1d' });
    console.log(`🔒 Your temporary cube.js token: ${cubejsToken}`);
    console.log(`🦅 Dev environment available at ${apiUrl}`);
    this.event('Dev Server Start');
    const serveStatic = require('serve-static');
    app.get('/playground/context', (req, res) => {
      this.event('Dev Server Env Open');
      res.json({
        cubejsToken: jwt.sign({}, this.apiSecret, { expiresIn: '1d' }),
        apiUrl,
        anonymousId: this.anonymousId
      });
    });

    app.get('/playground/db-schema', async (req, res) => {
      this.event('Dev Server DB Schema Load');
      const driver = await this.getDriver();
      const tablesSchema = await driver.tablesSchema();
      res.json({ tablesSchema });
    });

    app.get('/playground/files', async (req, res) => {
      this.event('Dev Server Files Load');
      const files = await this.repository.dataSchemaFiles();
      res.json({ files });
    });

    app.post('/playground/generate-schema', async (req, res) => {
      this.event('Dev Server Generate Schema');
      const driver = await this.getDriver();
      const tablesSchema = await driver.tablesSchema();

      const ScaffoldingTemplate = require('@cubejs-backend/schema-compiler/scaffolding/ScaffoldingTemplate');
      const scaffoldingTemplate = new ScaffoldingTemplate(tablesSchema);
      const files = scaffoldingTemplate.generateFilesByTableNames(req.body.tables);
      await Promise.all(files.map(file => fs.writeFile(path.join('schema', file.fileName), file.content)));
      res.json({ files });
    });

    app.use(serveStatic(path.join(__dirname, '../playground')));
  }

  createCompilerApi(repository) {
    return new CompilerApi(repository, this.dbType, {
      schemaVersion: this.options.schemaVersion,
      devServer: this.options.devServer,
      logger: this.logger
    });
  }

  createOrchestratorApi() {
    return new OrchestratorApi(() => this.getDriver(), this.logger, {
      redisPrefix: process.env.CUBEJS_APP,
      ...this.options.orchestratorOptions
    });
  }

  async getDriver() {
    if (!this.driver) {
      const driver = this.driverFactory();
      await driver.testConnection(); // TODO mutex
      this.driver = driver;
    }
    return this.driver;
  }

  static createDriver(dbType) {
    checkEnvForPlaceholders();
    // eslint-disable-next-line global-require,import/no-dynamic-require
    return new (require(CubejsServerCore.driverDependencies(dbType || process.env.CUBEJS_DB_TYPE)))();
  }

  static driverDependencies(dbType) {
    return DriverDependencies[dbType] || DriverDependencies.jdbc;
  }
}

module.exports = CubejsServerCore;
