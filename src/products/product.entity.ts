import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'products' })
export class Product {
  @PrimaryColumn({ name: 'product_id', type: 'varchar', length: 32 })
  productId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'integer' })
  price!: number;

  @Column({ name: 'available_stock', type: 'integer' })
  availableStock!: number;

  @Column({ name: 'remaining_stock', type: 'integer' })
  remainingStock!: number;

  @Column({ name: 'is_flash_sale_active', type: 'boolean' })
  isFlashSaleActive!: boolean;
}

