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
