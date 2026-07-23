import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({ 
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    return this.productsRepository.save(product);
  }

  async updateStock(id: number, quantity: number): Promise<Product> {
    const product = await this.findOne(id);
    product.stock = quantity;
    return this.productsRepository.save(product);
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
  }

  async searchProducts(query: string): Promise<Product[]> {
    const cacheKey = 'product-search';
    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const products = await this.productsRepository.find();
    const results = products.filter(p => 
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(query.toLowerCase())
    );

    await this.cacheManager.set(cacheKey, results, 60000);
    return results;
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({ relations: ['parent', 'children'] });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  async getCategoryTree(categoryId: number): Promise<any> {
    const category = await this.findCategory(categoryId);
    return this.buildCategoryTree(category);
  }

  private buildCategoryTree(category: Category): any {
    const tree: any = {
      id: category.id,
      name: category.name,
      children: [],
    };

    if (category.parentId) {
      tree.parent = this.buildCategoryTree(category.parent);
    }

    if (category.children && category.children.length > 0) {
      tree.children = category.children.map(child => this.buildCategoryTree(child));
    }

    return tree;
  }

  async processProductBatch(productIds: number[]): Promise<{ success: boolean; processed: number }> {
    let processed = 0;
    
    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          processed++;
        } catch (error) {
          console.log('Error processing product');
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
