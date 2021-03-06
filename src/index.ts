import { IDB, IStore } from "indexeddb"
import * as anglicize from "anglicize"
import {
  sanitizeBookmark,
  sanitizeCollection,
  sanitizeSearchQuery
} from "./sanitize"
import * as storage from "./storage"
import * as types from "./types"
import version from "./version"

const DEFAULT_OFFSET = 0
const DEFAULT_LIMIT = 10

export default class LikeDB {
  options: types.IDBOptions
  db: IDB
  bookmarksStore: IStore
  collectionsStore: IStore
  collectionLinksStore: IStore
  speedDialStore: IStore

  constructor(options?: types.IDBOptions) {
    this.options = options || { version }
    this.db = storage.db(this.options)
    this.bookmarksStore = storage.bookmarks(this.options)
    this.collectionsStore = storage.collections(this.options)
    this.collectionLinksStore = storage.collectionLinks(this.options)
    this.speedDialStore = storage.speedDial(this.options)
  }

  add(options: types.INewBookmark): Promise<any> {
    return this.bookmarksStore.add(
      sanitizeBookmark({
        url: options.url,
        title: options.title || "",
        tags: options.tags || [],
        createdAt: options.createdAt || Date.now(),
        updatedAt: Date.now()
      })
    )
  }

  count(): Promise<number> {
    return this.bookmarksStore.count()
  }

  delete(url: string): Promise<any> {
    return this.bookmarksStore.delete(url)
  }

  get(url: string): Promise<types.IBookmark> {
    return this.bookmarksStore.get(url) as Promise<types.IBookmark>
  }

  listByTag(
    tag: string,
    options?: types.IListOptions
  ): Promise<types.IBookmark[]> {
    const result: types.IBookmark[] = []
    const limit: number = options && options.limit ? options.limit : 25

    return new Promise((resolve, reject) => {
      this.bookmarksStore.select(
        "tags",
        { only: tag },
        (err?: Error, row?: types.IDBRow<types.IBookmark>) => {
          if (err) return reject(err)
          if (!row || result.length >= limit) {
            return resolve(result.sort(sortByCreatedAt))
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  recent(limit: number): Promise<types.IBookmark[]> {
    const result: types.IBookmark[] = []

    return new Promise((resolve, reject) => {
      this.bookmarksStore.select(
        "createdAt",
        null,
        "prev",
        (err: Error | undefined, row: types.IDBRow<types.IBookmark>) => {
          if (err) return reject(err)
          if (!row || result.length >= limit) {
            return resolve(result.sort(sortByCreatedAt))
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  createCollection({
    title,
    desc
  }: {
    title: string
    desc: string
  }): Promise<string | object> {
    return this.collectionsStore.add(
      sanitizeCollection({
        id: Date.now(),
        title,
        desc,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    ) as Promise<string | object>
  }

  async updateCollection(
    titleToUpdate: string,
    { title, desc }: { title: string; desc: string }
  ) {
    const collection = await this.createCollection({ title, desc })
    const links = await this.listByCollection(titleToUpdate, { limit: 99999 })

    await Promise.all(
      links.map(link =>
        this.addToCollection({
          ...link,
          collection: collection as string
        })
      )
    )

    await this.removeCollection(titleToUpdate)
  }

  async updateCollectionImage(title: string, imageUrl: string) {
    const existing = (await this.collectionsStore.get(
      title
    )) as types.ICollection

    return this.collectionsStore.update({
      ...existing,
      imageUrl,
      updatedAt: Date.now()
    }) as Promise<types.ISpeedDial>
  }

  async removeCollection(title: string) {
    const links = await this.listByCollection(title, { limit: 99999 })

    await Promise.all(
      links.map(link => this.removeFromCollection(link.url, title))
    )

    await this.collectionsStore.delete(title)
  }

  getCollection(title: string): Promise<types.ICollection> {
    return this.collectionsStore.get(title) as Promise<types.ICollection>
  }

  async addToCollection({
    collection,
    url,
    title,
    desc,
    createdAt,
    updatedAt
  }: {
    collection: string
    url: string
    title: string
    desc: string
    createdAt?: number
    updatedAt?: number
  }): Promise<types.ICollectionLink> {
    const coll = await this.getCollection(collection)

    if (!coll) {
      await this.createCollection({ title: collection, desc: "" })
    }

    return this.collectionLinksStore.add({
      key: `${collection}:${url}`,
      collection,
      url,
      createdAt: createdAt || Date.now(),
      updatedAt: updatedAt || Date.now()
    }) as Promise<types.ICollectionLink>
  }

  getCollectionsOfUrl(url: string): Promise<types.ICollection[]> {
    const result: types.ICollectionLink[] = []

    return new Promise((resolve, reject) => {
      return this.collectionLinksStore.select(
        "url",
        { only: url },
        async (err?: Error, row?: types.IDBRow<types.ICollectionLink>) => {
          if (err) return reject(err)
          if (!row) {
            return resolve(
              await Promise.all(
                result
                  .sort(sortCollByCreatedAt)
                  .map(collectionLinkToCollection(this.collectionsStore))
              )
            )
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  removeFromCollection(url: string, collection: string): Promise<object> {
    return this.collectionLinksStore.delete(`${collection}:${url}`)
  }

  listCollections(): Promise<types.ICollection[]> {
    const result: types.ICollection[] = []

    return new Promise((resolve, reject) => {
      this.collectionsStore.all(
        (err?: Error, row?: types.IDBRow<types.ICollection>) => {
          if (err) return reject(err)
          if (!row) {
            return resolve(result.sort(sortCollByCreatedAt))
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  async getRecentCollections(): Promise<types.ICollection[]> {
    const result: types.ICollectionLink[] = []
    const recentlyCreatedColls = (await this.listCollections()).reverse()

    return new Promise((resolve, reject) => {
      this.collectionLinksStore.all(
        async (err?: Error, row?: types.IDBRow<types.ICollectionLink>) => {
          if (err) return reject(err)
          if (!row) {
            return resolve(
              (await Promise.all(
                result.map(collectionLinkToCollection(this.collectionsStore))
              ))
                .concat(await this.listCollections())
                .filter(isUniqueCollection())
            )
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  searchCollections(query: string): Promise<types.ICollection[]> {
    const result: types.ICollection[] = []
    query = sanitizeSearchQuery(query)

    return new Promise((resolve, reject) => {
      this.collectionsStore.select(
        "normalizedTitle",
        { from: query, to: query + "\uffff" },
        "prev",
        (err?: Error, row?: types.IDBRow<types.ICollection>) => {
          if (err) return reject(err)
          if (!row) {
            return resolve(result.sort(sortCollByCreatedAt))
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  listByCollection(
    collection: string,
    options?: types.IListOptions
  ): Promise<types.ICollectionLink[]> {
    const all: types.ICollectionLink[] = []
    const result: types.ICollectionLink[] = []

    const offset: number = options && options.offset ? options.offset : 0
    const limit: number = options && options.limit ? options.limit : 25
    const filter: string =
      (options && options.filter && options.filter.trim()) || ""

    let index = 0

    return new Promise((resolve, reject) => {
      this.collectionLinksStore.select(
        "createdAt",
        null,
        "prev",
        async (err?: Error, row?: types.IDBRow<types.ICollectionLink>) => {
          if (err) return reject(err)

          if (!row || result.length >= limit) {
            return resolve(result.sort(sortByCreatedAt))
          }

          if (offset > 0 && index < offset) {
            index += 1
            return row.continue()
          }

          if (row.value.collection === collection) {
            result.push(row.value)
          }

          index += 1
          row.continue()
        }
      )
    })

    /*const result: types.ICollectionLink[] = []
    const offset: number = options && options.offset ? options.offset : 0
    const limit: number = options && options.limit ? options.limit : 25
    const filter: string =
      (options && options.filter && options.filter.trim()) || ""

    let index = 0

    return new Promise((resolve, reject) => {
      this.collectionLinksStore.select(
        "collection",
        { only: collection },
        async (err?: Error, row?: types.IDBRow<types.ICollectionLink>) => {
          if (err) return reject(err)

          if (!row || result.length >= limit) {
            return resolve(result.sort(sortByCreatedAt))
          }

          if (offset > 0 && index < offset) {
            return row.continue()
          }

          result.push(row.value)

          index += 1
          row.continue()
        }
      )
    })*/
  }

  addSpeedDial({
    key,
    url
  }: {
    key: string
    url: string
  }): Promise<types.ISpeedDial> {
    return this.speedDialStore.add({
      key,
      url,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }) as Promise<types.ISpeedDial>
  }

  getSpeedDialByKey(key: string): Promise<types.ISpeedDial> {
    return this.speedDialStore.get(key) as Promise<types.ISpeedDial>
  }

  async getSpeedDialByUrl(url: string): Promise<types.ISpeedDial> {
    const existing = await this.speedDialStore.getByIndex("url", url)
    return existing
  }

  async updateSpeedDial({
    key,
    url
  }: {
    key: string
    url: string
  }): Promise<types.ISpeedDial> {
    const existing = await this.speedDialStore.getByIndex("url", url)
    await this.speedDialStore.delete(existing.key)

    return this.speedDialStore.update({
      key,
      url,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }) as Promise<types.ISpeedDial>
  }

  removeSpeedDial(key: string): Promise<object> {
    return this.speedDialStore.delete(key)
  }

  async removeSpeedDialByUrl(url: string): Promise<object> {
    const current = await this.getSpeedDialByUrl(url)
    if (!current) {
      return {}
    }

    return this.speedDialStore.delete(current.key)
  }

  listSpeedDials(): Promise<types.ISpeedDial[]> {
    const result: types.ISpeedDial[] = []

    return new Promise((resolve, reject) => {
      this.speedDialStore.all(
        (err?: Error, row?: types.IDBRow<types.ISpeedDial>) => {
          if (err) return reject(err)
          if (!row) {
            return resolve(result.sort(sortSpeedDialByCreatedAt))
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  searchSpeedDials(query: string): Promise<types.ISpeedDial[]> {
    const result: types.ISpeedDial[] = []
    query = sanitizeSearchQuery(query)

    return new Promise((resolve, reject) => {
      this.speedDialStore.select(
        "key",
        { from: query, to: query + "\uffff" },
        "prev",
        (err?: Error, row?: types.IDBRow<types.ISpeedDial>) => {
          if (err) return reject(err)
          if (!row) {
            return resolve(result.sort(sortSpeedDialByCreatedAt))
          }

          result.push(row.value)
          row.continue()
        }
      )
    })
  }

  search(
    index: string,
    keyword: string,
    options?: types.IListOptions
  ): Promise<types.IBookmark[]> {
    const result: types.IBookmark[] = []
    const offset: number =
      options && options.offset ? options.offset : DEFAULT_OFFSET
    const limit: number =
      options && options.limit ? options.limit : DEFAULT_LIMIT

    let i = 0

    return new Promise((resolve, reject) => {
      this.bookmarksStore.select(
        index,
        { from: keyword, to: keyword + "\uffff" },
        "prev",
        (err: Error | undefined, row: types.IDBRow<types.IBookmark>) => {
          if (err) return reject(err)
          if (!row || result.length >= limit)
            return resolve(result.sort(sortByCreatedAt))

          if (i++ >= offset) {
            result.push(row.value)
          }

          row.continue()
        }
      )
    })
  }

  searchByTags(
    keyword: string,
    options: types.IListOptions
  ): Promise<types.IBookmark[]> {
    return this.search("tags", keyword, options || {})
  }

  searchByTitle(
    keyword: string,
    options: types.IListOptions
  ): Promise<types.IBookmark[]> {
    return this.search("cleanTitle", keyword, options || {})
  }

  searchByUrl(
    keyword: string,
    options: types.IListOptions
  ): Promise<types.IBookmark[]> {
    return this.search("cleanUrl", keyword, options || {})
  }

  untag(url: string, tag: string): Promise<any> {
    return (this.bookmarksStore.get(url) as Promise<
      types.IBookmarkWithTags
    >).then((row: types.IBookmarkWithTags) => {
      const index = row.tags ? row.tags.indexOf(tag) : -1

      if (index === -1) {
        throw new Error("Tag doesn't exist")
      }

      row.tags.splice(index, 1)
      row.updatedAt = Date.now()
      return this.bookmarksStore.update(row)
    })
  }

  async updateTitle(url: string, title: string): Promise<any> {
    const row = (await this.bookmarksStore.get(url)) as types.IBookmark
    row.title = title
    row.updatedAt = Date.now()
    return this.bookmarksStore.update(sanitizeBookmark(row))
  }

  tag(url: string, tag: string): Promise<any> {
    return (this.bookmarksStore.get(url) as Promise<types.IBookmark>).then(
      (row: types.IBookmark) => {
        if (!row.tags) {
          row.tags = [tag]
          row.updatedAt = Date.now()
          return this.bookmarksStore.update(row)
        }

        if (row.tags.indexOf(tag) > -1) {
          throw new Error("Tag already added")
        }

        row.tags.push(tag)
        row.updatedAt = Date.now()
        return this.bookmarksStore.update(row)
      }
    )
  }

  deleteDB(): Promise<any> {
    return this.db.delete()
  }
}

function sortByCreatedAt(a: types.IBookmark, b: types.IBookmark): number {
  if (a.createdAt > b.createdAt) {
    return -1
  }

  if (a.createdAt < b.createdAt) {
    return 1
  }

  return 0
}

function sortCollByCreatedAt(
  a: types.ICollection,
  b: types.ICollection
): number {
  if (a.createdAt > b.createdAt) {
    return -1
  }

  if (a.createdAt < b.createdAt) {
    return 1
  }

  return 0
}

function sortCollLinksByCreatedAt(
  a: types.ICollection,
  b: types.ICollection
): number {
  if (a.createdAt > b.createdAt) {
    return 1
  }

  if (a.createdAt < b.createdAt) {
    return -1
  }

  return 0
}

function sortSpeedDialByCreatedAt(
  a: types.ISpeedDial,
  b: types.ISpeedDial
): number {
  if (a.createdAt < b.createdAt) {
    return 1
  }

  if (a.createdAt > b.createdAt) {
    return -1
  }

  return 0
}

function isUniqueCollection() {
  const mem = {}

  return function(coll: types.ICollection): boolean {
    if (mem[coll.title]) {
      return false
    }

    mem[coll.title] = true

    return true
  }
}

function collectionLinkToCollection(collectionsStore: IStore) {
  return function(cl: types.ICollectionLink) {
    return collectionsStore.get(cl.collection) as Promise<types.ICollection>
  }
}
