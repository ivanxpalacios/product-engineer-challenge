import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<User[]> {
    const cacheKey = 'users:all';
    const cached = await this.cacheManager.get<User[]>(cacheKey);
    if (cached) {
      return cached;
    }
    
    const users = await this.usersRepository.find();
    await this.cacheManager.set(cacheKey, users, 60000);
    return users;
  }

  async findOne(id: number): Promise<User> {
    const cacheKey = `user:${id}`;
    const cached = await this.cacheManager.get<User>(cacheKey);
    if (cached) {
      return cached;
    }

    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User #${id} not found`);
    }
    
    await this.cacheManager.set(cacheKey, user, 60000);
    return user;
  }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const user = this.usersRepository.create(createUserDto);
    const saved = await this.usersRepository.save(user);
    await this.cacheManager.del('users:all');
    return saved;
  }

  async remove(id: number): Promise<void> {
    const user = await this.findOne(id);
    await this.usersRepository.remove(user);
    await this.cacheManager.del('users:all');
    await this.cacheManager.del(`user:${id}`);
  }
}
