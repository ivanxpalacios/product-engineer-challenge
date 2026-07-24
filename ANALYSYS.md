# Análisis de Bugs — Product Engineer Challenge

## Bug #1: Caché de búsqueda de productos compartida entre términos distintos

### Descripción

El endpoint `GET /products/search?q=<term>` usa Redis para cachear los resultados
de búsqueda por 60 segundos. El problema es que la key de caché era un string fijo
(`'product-search'`), sin incluir el término de búsqueda (`query`). Esto provocaba
que la primera búsqueda que se ejecutara quedara cacheada bajo esa única key, y
que **cualquier búsqueda posterior con un término diferente devolviera los mismos
resultados de la primera búsqueda**, en vez de buscar el término correcto, mientras
esa entrada siguiera vigente en el caché (hasta 60 segundos).

Ejemplo del síntoma: buscar `q=Dress` devuelve productos de vestidos correctamente.
Acto seguido, buscar `q=Laptop` devuelve los mismos productos de vestidos, porque
la lectura de caché (`cacheManager.get('product-search')`) encuentra la entrada
dejada por la búsqueda anterior y la retorna sin volver a filtrar por el nuevo término.

### Código

**Archivo:** `src/products/products.service.ts`, método `searchProducts`

**Antes:**
```ts
async searchProducts(query: string): Promise<Product[]> {
  ...
  const cacheKey = 'product-search';
  ...
}
```

**Después:**
```ts
async searchProducts(query: string): Promise<Product[]> {
  ...
  const cacheKey = `product-search:${query.toLowerCase()}`;
  ...
}
```

### Por qué es la mejor solución

- **Causa raíz, no síntoma:** el bug no está en la lógica de filtrado ni en el
  mecanismo de caché en sí (TTL, cliente Redis, etc.) — está únicamente en que la
  key no identifica de forma única el contenido que representa. Cambiar la key es
  el punto exacto donde se rompe la invariante ("una key debe representar un único
  resultado"), así que ahí es donde se corrige.
- **`toLowerCase()`** normaliza la key para que `q=Dress` y `q=dress` compartan la
  misma entrada de caché, evitando duplicar entradas para lo que en la práctica es
  la misma búsqueda (el filtrado ya era case-insensitive, así que la key ahora es
  consistente con ese comportamiento).

### Mediciones

Medido con `curl -w "%{time_total}"` contra el servidor local, comparando 5
términos de búsqueda nuevos (sin caché) contra los mismos 5 términos ya cacheados:

| Escenario | Tiempo de respuesta |
|---|---|
| Sin caché (primera búsqueda de un término) | ~5–8 ms |
| Con caché (búsqueda repetida del mismo término) | ~0.9–1.7 ms |

Además de la mejora de performance esperable por el caché, la corrección elimina
el problema funcional: antes, la "mejora" de performance era en realidad un bug
(resultados incorrectos servidos desde caché); después, cada término tiene su
propia entrada y los resultados cacheados corresponden siempre al término
solicitado.

## Bug #2: Árbol de categorías crashea o cuelga la request (`getCategoryTree`)

### Descripción

El endpoint `GET /categories/:id/tree` debía devolver la jerarquía completa de
una categoría (ancestros y descendientes). La implementación original
(`buildCategoryTree`) asumía que las relaciones `parent` y `children` de
TypeORM venían pobladas recursivamente a cualquier profundidad, cuando en
realidad `findCategory` solo carga **un nivel** de esas relaciones. Como
resultado, cualquier categoría con hijos o con un padre a más de un nivel de
profundidad producía un `500 Internal server error` sin detalle útil
(`Cannot read properties of undefined (reading 'id')`), y el árbol devuelto
(cuando no crasheaba) le faltaban nietos o abuelos silenciosamente.

Al corregir esto para que cada nodo consultara la base de datos por sí mismo
(en vez de depender de relaciones precargadas), apareció un segundo problema:
la misma función se usaba tanto para subir hacia el padre como para bajar
hacia los hijos, y ambos caminos se retroalimentaban. Por ejemplo, con
`Electronics (id 1)` → `Mobile Devices (id 4, parentId 1)`:

1. Pedir el árbol de la categoría 4 sube a buscar su padre (categoría 1).
2. Al construir el árbol de la categoría 1, se buscan sus hijos y se
   encuentra de nuevo a la categoría 4.
3. Se vuelve a construir el árbol de la categoría 4, que vuelve a subir a
   la categoría 1... y así indefinidamente.

Esto producía una request que **nunca completaba** (colgada), calzando
directamente con el síntoma reportado *"some requests are extremely slow or
never complete"*.

### Código

**Archivo:** `src/products/products.service.ts`, `getCategoryTree` / `buildCategoryTree`

**Antes:**
```ts
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
```

**Después:**
```ts
async getCategoryTree(categoryId: number): Promise<any> {
  const category = await this.findCategory(categoryId);
  const tree: any = {
    id: category.id,
    name: category.name,
    children: await this.buildDescendants(category.id),
  };

  if (category.parentId) {
    tree.parent = await this.buildAncestors(category.parentId);
  }

  return tree;
}

private async buildDescendants(categoryId: number): Promise<any[]> {
  const children = await this.categoriesRepository.find({ where: { parentId: categoryId } });
  return Promise.all(
    children.map(async child => ({
      id: child.id,
      name: child.name,
      children: await this.buildDescendants(child.id),
    })),
  );
}

private async buildAncestors(categoryId: number): Promise<any> {
  const category = await this.categoriesRepository.findOne({ where: { id: categoryId } });
  if (!category) {
    return null;
  }

  const node: any = { id: category.id, name: category.name };
  if (category.parentId) {
    node.parent = await this.buildAncestors(category.parentId);
  }

  return node;
}
```

### Por qué es la mejor solución

- **Causa raíz, no síntoma:** el problema real era doble: (1) confiar en
  relaciones de TypeORM precargadas a profundidad arbitraria, cuando solo se
  carga un nivel, y (2) usar una sola función recursiva para dos direcciones
  de recorrido (hacia el padre y hacia los hijos) que terminan
  encontrándose entre sí. La solución ataca ambos: cada nodo resuelve sus
  propias relaciones consultando la base de datos directamente por `id` /
  `parentId` (ya no depende de qué haya precargado la query original), y se
  separan explícitamente dos funciones — `buildDescendants` (solo baja) y
  `buildAncestors` (solo sube) — que nunca se llaman entre sí, eliminando la
  posibilidad estructural de un ciclo.
- **Elimina el crash y el colgado:** al no depender de relaciones parcialmente
  cargadas, no hay más `undefined` inesperados; al separar direcciones, no
  hay más recursión mutua infinita.
- **Preserva el comportamiento esperado:** el endpoint sigue devolviendo tanto
  ancestros (`parent`) como descendientes (`children`) a cualquier
  profundidad, que es lo que el nombre y la forma de la respuesta original
  sugerían, sin rediseñar el endpoint ni cambiar su contrato externo.
- **Mínimo alcance:** no toca `findCategory`, el controlador, ni ningún otro
  método del servicio.

### Mediciones

Antes del fix, la request a `/categories/:id/tree` para cualquier categoría
con hijos terminaba en `500` (o, tras la primera corrección parcial,
colgada indefinidamente sin responder — hubo que cancelarla manualmente).

Después del fix, medido con `curl -w "%{time_total}"` contra el servidor
local, sobre la jerarquía real `Electronics (1) → Mobile Devices (4) → Apple (5)`:

| Endpoint | Tiempo de respuesta | Status |
|---|---|---|
| `GET /categories/1/tree` | ~12–23 ms | 200 |
| `GET /categories/4/tree` | ~8–16 ms | 200 |

Respuesta verificada para `GET /categories/1/tree`:
```json
{"id":1,"name":"Electronics","children":[{"id":4,"name":"Mobile Devices","children":[{"id":5,"name":"Apple","children":[]}]}]}
```

## Bug #3: `processProductBatch` reporta éxito aunque todo haya fallado, con errores sin detalle

### Descripción

El endpoint `POST /products/batch` procesa una lista de `productIds`, actualizando
su `updatedAt`. Tenía dos problemas de reporte de errores:

1. Cada fallo individual (por ejemplo, un `id` que no existe) se atrapaba con un
   `catch` interno que solo hacía `console.log('Error processing product')` — un
   mensaje genérico, sin el `id` ni el error real, útil solo en la terminal del
   servidor y nunca visible para quien llamó al endpoint.
2. La respuesta devuelta era siempre `{ success: true, processed: N }`, sin
   importar cuántos (o todos) los IDs hubieran fallado. Con
   `productIds: [999, 1000]` (ambos inexistentes), el endpoint respondía
   `{ success: true, processed: 0 }` — "éxito" total cuando en realidad no se
   procesó nada.

Esto calza directamente con el síntoma *"some failures produce vague or
misleading error messages"* de `INSTRUCTIONS.md`.

Adicionalmente, el `try/catch` que envolvía todo el `for` no era del todo código
muerto (si `productIds` no fuera un array iterable, el `for...of` fallaría ahí y
ese catch devolvía un `400` genérico), pero mezclaba dos responsabilidades
distintas — validación de entrada vs. errores por ítem — en un solo mecanismo,
lo que hacía el flujo confuso de leer.

### Código

**Archivo:** `src/products/products.service.ts`, método `processProductBatch`

**Antes:**
```ts
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
```

**Después:**
```ts
async processProductBatch(
  productIds: number[],
): Promise<{
  results: { id: number; success: boolean; error?: string }[];
  processed: number;
  failed: number;
}> {
  const results: { id: number; success: boolean; error?: string }[] = [];

  try {
    for (const id of productIds) {
      try {
        const product = await this.findOne(id);
        product.updatedAt = new Date();
        await this.productsRepository.save(product);
        results.push({ id, success: true });
      } catch (error) {
        results.push({ id, success: false, error: error.message });
      }
    }
  } catch (error) {
    throw new BadRequestException('Batch processing failed');
  }

  const processed = results.filter(r => r.success).length;
  const failed = results.length - processed;

  return { results, processed, failed };
}
```

### Por qué es la mejor solución

- **Cambio mínimo de estructura:** se conserva el mismo mecanismo de control
  de flujo del código original (el `try/catch` externo sigue ahí, atrapando
  casos como `productIds` no iterable y devolviendo `400`), para mantener el
  diff lo más pequeño posible — se evaluó reemplazarlo por un guard explícito
  (`if (!Array.isArray(...))`) pero se descartó para no ampliar el alcance del
  cambio más allá del bug reportado.
- **Reporte por ítem, no solo agregados:** en vez de solo contar fallos, cada
  elemento de `productIds` genera una entrada en `results` con su `id` y si
  tuvo éxito o no (y el error real si falló). Así el caller puede reconciliar
  exactamente qué pasó con cada producto que envió — esta es la forma que
  suelen usar APIs de batch en producción (Stripe, AWS Batch, mutaciones bulk
  de GraphQL), en vez de devolver solo un conteo de éxitos y una lista aparte
  de fallidos.
- **`error.message` real en vez de un log genérico:** el detalle del error
  ahora viaja en la respuesta HTTP, visible para quien llamó al endpoint, no
  solo en un `console.log` que solo ve quien tiene acceso a los logs del
  servidor.
- **Cambio de forma de respuesta, no de comportamiento central:** sigue
  procesando todos los IDs que pueda y reportando los que fallen, sin abortar
  el batch completo por un solo error — se preserva la intención original de
  "procesamiento parcial tolerante a fallos", solo se corrige cómo se reporta.

### Mediciones

Medido con `curl` contra el servidor local:

| Caso | Body enviado | Status | `processed`/`failed` | Tiempo |
|---|---|---|---|---|
| Mezcla válidos/inválidos | `{"productIds":[1,4,999,1000]}` | 201 | `processed: 2`, `failed: 2` | ~28 ms |
| Todos inválidos | `{"productIds":[999,1000]}` | 201 | `processed: 0`, `failed: 2` | ~3 ms |
| Array vacío | `{"productIds":[]}` | 201 | `processed: 0`, `failed: 0`, `results: []` | ~2 ms |

Antes del fix, los tres casos habrían devuelto `{ success: true, processed: N }`
sin distinguir cuáles IDs fallaron ni por qué. El caso de array vacío no lanza
error (ni antes ni después del fix) — es un batch sin ítems que procesar, no una
entrada inválida, así que responder `201` con `results: []` es el comportamiento
correcto; validar que `productIds` no esté vacío se consideró y se descartó por
estar fuera del alcance de este bug.

## Bug #4: `POST /users` responde `500 Internal server error` al crear un email duplicado

### Descripción

El campo `email` de `User` es `@Column({ unique: true })`, pero el método
`create` de `UsersService` no manejaba el caso de violación de esa restricción:
simplemente llamaba a `usersRepository.save(user)` y dejaba que cualquier error
de la base de datos se propagara tal cual. Postgres rechaza el `INSERT` con un
error de unique constraint (`code: '23505'`), que TypeORM re-lanza sin traducir,
y como Nest no sabe qué hacer con una excepción no reconocida, cae al manejador
genérico y responde `500 Internal server error` sin ningún detalle — calzando
directamente con el síntoma *"some failures produce vague or misleading error
messages"* de `INSTRUCTIONS.md`.

### Código

**Archivo:** `src/users/users.service.ts`, método `create`

**Antes:**
```ts
async create(createUserDto: CreateUserDto): Promise<User> {
  const user = this.usersRepository.create(createUserDto);
  const saved = await this.usersRepository.save(user);
  await this.cacheManager.del('users:all');
  return saved;
}
```

**Después:**
```ts
async create(createUserDto: CreateUserDto): Promise<User> {
  const user = this.usersRepository.create(createUserDto);
  try {
    const saved = await this.usersRepository.save(user);
    await this.cacheManager.del('users:all');
    return saved;
  } catch (error) {
    if (error.code === '23505') {
      throw new ConflictException(`Email ${createUserDto.email} is already in use`);
    }
    throw error;
  }
}
```

### Por qué es la mejor solución

- **Causa raíz, no síntoma:** el problema no es la restricción `unique` (que es
  correcta y debe mantenerse), sino que no había ninguna traducción de ese error
  esperable de negocio a una respuesta HTTP significativa. Se captura
  específicamente el código de Postgres para violación de unique constraint
  (`23505`) y se traduce a una excepción de Nest; cualquier otro error
  (`error.code` distinto) se vuelve a lanzar tal cual, sin enmascarar fallos
  genuinamente inesperados.
- **`ConflictException` (409) en vez de `BadRequestException` (400):** se
  evaluó usar `BadRequestException` para mantener el mismo patrón que
  `products.service.ts` y `orders.service.ts` (que solo usan `NotFoundException`
  y `BadRequestException`), pero se decidió mantener `ConflictException` porque
  es semánticamente más correcto: el body de la request es válido en sí mismo
  (un email con formato correcto), el conflicto es con el *estado actual del
  servidor* (ya existe un recurso con ese email), que es exactamente para lo
  que existe el código 409 en HTTP.
- **Mínimo alcance:** no toca `findOne`, `remove`, el controlador, el DTO, ni
  la restricción `unique` de la entidad.

### Mediciones

Medido con `curl` contra el servidor local:

| Caso | Antes | Después |
|---|---|---|
| Crear usuario con email nuevo | `201`, usuario creado | `201`, usuario creado (sin cambios) |
| Crear usuario con email ya existente | `500 Internal server error` (sin detalle) | `409 Conflict`, `{"message":"Email ivan@test.com is already in use","error":"Conflict","statusCode":409}` |
