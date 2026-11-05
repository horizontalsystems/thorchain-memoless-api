import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';

// Services
import { ThorchainApiService } from './services/thorchain-api.service';
import { WalletService } from './services/wallet.service';
import { TransactionService } from './services/transaction.service';
import { MemolessService } from './services/memoless.service';
import { DatabaseService } from './services/database.service';
import { RegistrationService } from './services/registration.service';
import { NotificationService } from './services/notification.service';

// Controllers
import { AssetsController } from './controllers/assets.controller';
import { RegistrationController } from './controllers/registration.controller';

// Config
import { getNetworkConfig, validateEnvironmentVariables } from './config/network.config';
import { SwaggerConfig } from './config/swagger.config';

export class MemolessApiApplication {
  private app: express.Application;
  private server: any;
  
  // Services
  private thorchainApi: ThorchainApiService;
  private walletService: WalletService;
  private transactionService: TransactionService;
  private memolessService: MemolessService;
  private databaseService: DatabaseService;
  private registrationService: RegistrationService;
  private notificationService: NotificationService;

  // Controllers
  private assetsController: AssetsController;
  private registrationController: RegistrationController;

  constructor() {
    // Validate environment
    validateEnvironmentVariables();

    // Get network configuration
    const config = getNetworkConfig();
    console.log(`🚀 Initializing Memoless API for ${config.network}`);

    // Initialize wallet service first to get address for client ID
    this.walletService = new WalletService(config);
    
    // Initialize other services (thorchain API will get wallet address later)
    this.thorchainApi = new ThorchainApiService(config);
    this.transactionService = new TransactionService(this.walletService, config);
    this.memolessService = new MemolessService(
      this.thorchainApi,
      this.transactionService,
      this.walletService,
      config
    );
    this.databaseService = new DatabaseService();
    this.notificationService = new NotificationService();
    this.registrationService = new RegistrationService(
      this.memolessService,
      this.walletService,
      this.databaseService,
      this.notificationService,
      config
    );

    // Initialize controllers
    this.assetsController = new AssetsController(this.registrationService);
    this.registrationController = new RegistrationController(this.registrationService);

    // Setup Express app
    this.app = express();
    this.setupMiddleware();
    this.setupSwagger();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private setupMiddleware(): void {
    // Security middleware
    this.app.use(helmet());
    this.app.use(cors({
      origin: process.env.CORS_ORIGINS?.split(',') || '*',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // Behind a reverse proxy every request arrives from the proxy's address, so without this the
    // limiter below counts every client in ONE bucket. TRUST_PROXY names the proxies whose
    // X-Forwarded-For is believed (e.g. "loopback" for a proxy on the same host, or a hop count);
    // req.ip is then the address the proxy saw, which the client cannot forge. Unset: Express's
    // default, req.ip is the TCP peer.
    const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
    if (trustProxy !== undefined) this.app.set('trust proxy', trustProxy);

    // Callers exempt from the limiter, by req.ip: e.g. a backend on the same host calling this API
    // directly (RATE_LIMIT_EXEMPT_IPS=127.0.0.1,::1), whose requests would otherwise share the
    // public budget. Requests that come through the proxy carry the client's address, not these.
    const exemptIps = new Set(
      (process.env.RATE_LIMIT_EXEMPT_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean)
    );

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.RATE_LIMIT || '100'), // limit each IP to 100 requests per windowMs
      skip: req => exemptIps.size > 0 && exemptIps.has((req.ip || '').replace(/^::ffff:/, '')),
      message: {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests from this IP, please try again later.'
        }
      }
    });
    this.app.use(limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });
  }

  private setupSwagger(): void {
    // Initialize Swagger documentation
    SwaggerConfig.initialize(this.app);
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', async (req, res) => {
      try {
        const nodeInfo = await this.thorchainApi.getNodeInfo();
        const walletReady = this.walletService.isWalletReady();
        const dbStatus = this.databaseService.getDatabaseStatus();
        
        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          wallet: {
            address: walletReady ? this.walletService.getAddress() : 'not initialized',
            ready: walletReady,
            network: this.walletService.getCurrentNetwork()
          },
          thorchain: {
            connected: nodeInfo.endpoints_working || false,
            status: nodeInfo.status
          },
          database: {
            enabled: dbStatus.enabled,
            type: dbStatus.type,
            connected: dbStatus.connected,
            note: dbStatus.enabled ? 'Registrations will be persisted' : 'Running without persistent storage'
          }
        });
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          error: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // API routes
    const apiRouter = express.Router();

    // Assets routes
    apiRouter.get('/assets', this.assetsController.getAssets.bind(this.assetsController));
    apiRouter.get('/assets/:asset', this.assetsController.getAssetDetails.bind(this.assetsController));

    // Registration routes
    apiRouter.post('/register', this.registrationController.registerMemo.bind(this.registrationController));
    apiRouter.get('/register/:registrationId', this.registrationController.getRegistrationStatus.bind(this.registrationController));
    apiRouter.post('/preflight', this.registrationController.preflightCheck.bind(this.registrationController));
    apiRouter.post('/suggest-amounts', this.registrationController.suggestAmounts.bind(this.registrationController));
    apiRouter.post('/track-transaction', this.registrationController.trackTransaction.bind(this.registrationController));

    this.app.use('/api/v1', apiRouter);

    // Root route
    this.app.get('/', (req, res) => {
      const port = process.env.PORT || '3000';
      res.json({
        name: 'THORChain Memoless Registration API',
        version: '1.0.0',
        network: this.walletService.getCurrentNetwork(),
        endpoints: {
          health: '/health',
          assets: '/api/v1/assets',
          register: '/api/v1/register',
          documentation: '/docs',
          openapi: '/api/openapi.json'
        },
        documentation: {
          swagger: `http://localhost:${port}/docs`,
          openapi: {
            json: `http://localhost:${port}/api/openapi.json`,
            yaml: `http://localhost:${port}/api/openapi.yaml`
          }
        }
      });
    });
  }

  private setupErrorHandling(): void {
    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
      });
    });

    // Global error handler
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('❌ Unhandled error:', error);
      
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
        }
      });
    });
  }

  async initialize(): Promise<void> {
    try {
      console.log('🔧 Initializing services...');
      
      // Initialize all services
      await this.registrationService.initialize();
      
      // Update THORChain API client ID with wallet address
      const walletAddress = this.walletService.getAddress();
      this.thorchainApi.updateClientId(walletAddress);
      
      // Inject ThorchainApiService into WalletService for balance operations
      this.walletService.setThorchainApi(this.thorchainApi);
      
      console.log('✅ All services initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize services:', error);
      throw error;
    }
  }

  async start(): Promise<any> {
    try {
      const port = parseInt(process.env.PORT || '3000');
      // Unset: every interface. Behind a proxy on the same host, 127.0.0.1.
      const host = process.env.HOST || undefined;
      
      // Create HTTP server
      this.server = createServer(this.app);
      
      
      // Start HTTP server
      await new Promise<void>((resolve, reject) => {
        this.server.listen(port, host, (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            console.log(`🚀 HTTP server listening on port ${port}`);
            resolve();
          }
        });
      });

      console.log('✅ Memoless API started successfully');
      console.log(`📡 HTTP API: http://localhost:${port}`);
      console.log(`📚 Swagger UI: http://localhost:${port}/docs`);
      console.log(`🌐 Network: ${this.walletService.getCurrentNetwork()}`);
      console.log(`💳 Hot wallet: ${this.walletService.getAddress()}`);
      
      return this.server;
    } catch (error) {
      console.error('❌ Failed to start server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      console.log('🛑 Shutting down Memoless API...');
      
      
      // Close HTTP server
      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server.close(() => {
            console.log('✅ HTTP server closed');
            resolve();
          });
        });
      }
      
      // Close database connections
      await this.databaseService.cleanup();
      
      console.log('✅ Memoless API shut down successfully');
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      throw error;
    }
  }
}

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM signal');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT signal');
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

/** TRUST_PROXY as Express's `trust proxy` setting: "true"/"false", a hop count, or address names. */
function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
