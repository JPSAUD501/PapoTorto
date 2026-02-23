/* eslint-disable */
export type Id<TableName extends string = string> = string & { __tableName: TableName };
export type Doc<TableName extends string = string> = Record<string, unknown> & { _id: Id<TableName> };
