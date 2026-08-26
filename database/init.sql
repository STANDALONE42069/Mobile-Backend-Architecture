CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE order_status AS ENUM ('CONFIRMED');

CREATE TABLE products (
  product_id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  available_stock INTEGER NOT NULL CHECK (available_stock >= 0),
  remaining_stock INTEGER NOT NULL CHECK (remaining_stock >= 0),
  is_flash_sale_active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (remaining_stock <= available_stock)
);

CREATE TABLE orders (
  order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(32) NOT NULL REFERENCES products(product_id),
  status order_status NOT NULL DEFAULT 'CONFIRMED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_orders_user_product UNIQUE (user_id, product_id)
);

CREATE INDEX idx_orders_product_id ON orders(product_id);

INSERT INTO products (
  product_id,
  name,
  description,
  price,
  available_stock,
  remaining_stock,
  is_flash_sale_active
)
SELECT
  item->>'productId',
  item->>'name',
  item->>'description',
  (item->>'price')::NUMERIC::INTEGER,
  (item->>'availableStock')::INTEGER,
  (item->>'availableStock')::INTEGER,
  (item->>'isFlashSaleActive')::BOOLEAN
FROM jsonb_array_elements(
  pg_read_file('/docker-entrypoint-initdb.d/products-seed.json')::JSONB
) AS item;
