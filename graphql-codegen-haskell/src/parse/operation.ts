import {
  assertEnumType,
  DocumentNode,
  GraphQLObjectType,
  GraphQLSchema,
  isEnumType,
  Kind,
  OperationDefinitionNode,
  print as renderGraphQLNode,
} from 'graphql'

import { ParsedFragments } from './fragments'
import { ParsedSelection, parseSelectionSet } from './selectionSet'
import {
  ParsedVariableDefinitions,
  parseVariableDefinitions,
} from './variableDefinition'

export type ParsedOperations = {
  // Sorted alphabetically and contains no duplicates
  enums: ParsedEnum[]
  operations: ParsedOperation[]
}

export type ParsedEnum = {
  // The name of the enum, e.g. "Status"
  name: string
  // The values in the enum, e.g. ["OPEN", "CLOSED"]
  values: string[]
}

export type ParsedOperation = {
  // The name of the operation, e.g. "getUser"
  name: string

  // The query document, e.g. "query getUser($id: Int!) { user(id: $id) { name } }"
  queryText: string
  // The name of the Haskell query, e.g. "GetUserQuery" or "CreateUserMutation"
  queryName: string

  // The GraphQL arguments
  args: Array<ParsedVariableDefinitions>

  // The name of the Haskell schema type, e.g. "GetUserSchema"
  schemaType: string
  // The schema of the GraphQL result
  schema: ParsedSelection
}

export const parseOperations = (
  ast: DocumentNode,
  schema: GraphQLSchema,
  fragments: ParsedFragments
): ParsedOperations => {
  const operationNodes = ast.definitions.filter(
    ({ kind }) => kind === Kind.OPERATION_DEFINITION
  ) as OperationDefinitionNode[]

  const parser = new OperationDefinitionParser(schema, fragments)
  const operations = operationNodes.map((operation) =>
    parser.parseOperation(operation)
  )
  const enums = Array.from(parser.getEnums())
    .sort()
    .map((enumName) => {
      const enumType = assertEnumType(schema.getType(enumName))
      return {
        name: enumName,
        values: enumType.getValues().map(({ name }) => name),
      }
    })

  return { enums, operations }
}

class OperationDefinitionParser {
  private _enums: Set<string>
  private _unnamedCounter: number

  constructor(
    readonly schema: GraphQLSchema,
    readonly fragments: ParsedFragments
  ) {
    this._enums = new Set()
    this._unnamedCounter = 0
  }

  getEnums(): Set<string> {
    return this._enums
  }

  parseOperation(node: OperationDefinitionNode) {
    const name = node.name?.value ?? `unnamed${this._unnamedCounter++}`
    const capitalName = capitalize(name)
    const opType = capitalize(node.operation)

    const args = parseVariableDefinitions(node.variableDefinitions ?? [])

    let schemaRoot: GraphQLObjectType | undefined | null
    switch (node.operation) {
      case 'query':
        schemaRoot = this.schema.getQueryType()
        break
      case 'mutation':
        schemaRoot = this.schema.getMutationType()
        break
      case 'subscription':
        schemaRoot = this.schema.getSubscriptionType()
        break
    }
    if (!schemaRoot) {
      throw new Error(
        `Unable to find root schema type for operation type "${node.operation}"`
      )
    }

    node.variableDefinitions?.forEach((v) => {
      let type = v.type.kind == "NonNullType" ? v.type.type : v.type;
      if (type.kind == 'NamedType') {
        let schemaType = this.schema.getType(type.name.value);
        if (isEnumType(schemaType)) {
          this._enums.add(schemaType.name);
        }
      }
    });

    const { enums, fragments, selections } = parseSelectionSet(
      this.schema,
      node.selectionSet,
      schemaRoot,
      this.fragments
    )

    enums.forEach((e) => {
      this._enums.add(e)
    })

    return {
      name,
      queryText: [
        renderGraphQLNode(node),
        ...fragments.map((fragment) =>
          renderGraphQLNode(this.fragments[fragment])
        ),
      ].join('\n'),
      queryName: `${capitalName}${opType}`,
      args,
      schemaType: `${capitalName}Schema`,
      schema: selections,
    }
  }
}

const capitalize = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase())
