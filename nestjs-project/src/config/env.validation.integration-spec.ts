import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'minio',
  STORAGE_ACCESS_KEY: 'key',
  STORAGE_SECRET_KEY: 'secret',
  STORAGE_BUCKET: 'streamtube',
  REDIS_HOST: 'redis',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage & queue', () => {
  const validateRaw = (env: Record<string, string | undefined>) =>
    envValidationSchema.validate(
      { ...requiredEnv, ...env },
      { allowUnknown: true, abortEarly: false },
    );

  it.each([
    'STORAGE_ENDPOINT',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
    'STORAGE_BUCKET',
    'REDIS_HOST',
  ])('should reject when required var %s is missing', (key) => {
    const { error } = validateRaw({ [key]: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should apply defaults for STORAGE_PORT, STORAGE_REGION and REDIS_PORT', () => {
    const { value, error } = validateRaw({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_PORT).toBe(9000);
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should accept a full valid storage & queue configuration', () => {
    const { error } = validateRaw({
      STORAGE_PORT: '9000',
      STORAGE_REGION: 'us-east-1',
      REDIS_PORT: '6379',
    });
    expect(error).toBeUndefined();
  });
});
