import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

import { outputSchemaFor } from './output-schemas'

type ToolContract = {
  title: string
  annotations: Required<
    Pick<
      ToolAnnotations,
      'readOnlyHint' | 'destructiveHint' | 'openWorldHint'
    >
  >
}

const read = (title: string): ToolContract => ({
  title,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  }
})

const add = (title: string): ToolContract => ({
  title,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false
  }
})

const mutate = (title: string): ToolContract => ({
  title,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false
  }
})

const destroy = (title: string): ToolContract => ({
  title,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false
  }
})

export const toolContracts = {
  add_blocker: add('Add blocker'),
  remove_blocker: mutate('Remove blocker'),
  claim_task: mutate('Claim task'),
  release_task: mutate('Release task'),
  take_over_task: mutate('Take over task'),
  list_cards: read('List cards'),
  search_cards: read('Search cards'),
  get_card: read('Get card'),
  get_card_by_key: read('Get card by key'),
  get_cards: read('Get cards'),
  get_commit_diff: read('Get commit diff'),
  create_card: add('Create card'),
  update_card: mutate('Update card'),
  set_card_status: mutate('Set card status'),
  reorder_cards: mutate('Reorder cards'),
  move_card_to_backlog: mutate('Move card to backlog'),
  move_card_to_sprint: mutate('Move card to sprint'),
  archive_card: mutate('Archive card'),
  restore_card: mutate('Restore card'),
  destroy_card: destroy('Destroy card'),
  list_comments: mutate('List comments'),
  list_unhandled_comments: mutate('List unhandled comments'),
  add_comment: add('Add comment'),
  update_comment: mutate('Update comment'),
  mark_comments_handled: mutate('Mark comments handled'),
  delete_comment: destroy('Delete comment'),
  issue_commit_token: add('Issue commit token'),
  list_docs: read('List docs'),
  read_doc: read('Read doc'),
  search_docs: read('Search docs'),
  write_doc: mutate('Write doc'),
  archive_doc: mutate('Archive doc'),
  restore_doc: mutate('Restore doc'),
  destroy_doc: destroy('Destroy doc'),
  create_inbox: add('Create inbox demand'),
  list_inbox: read('List inbox demands'),
  update_inbox: mutate('Update inbox demand'),
  mark_inbox_planned: mutate('Mark inbox demand planned'),
  archive_inbox: mutate('Archive inbox demand'),
  restore_inbox: mutate('Restore inbox demand'),
  destroy_inbox: destroy('Destroy inbox demand'),
  list_projects: read('List projects'),
  get_project: read('Get project'),
  create_project: add('Create project'),
  update_project_key_prefix: mutate('Update project key prefix'),
  archive_project: mutate('Archive project'),
  restore_project: mutate('Restore project'),
  destroy_project: destroy('Destroy project'),
  set_project_repo: mutate('Set project repository'),
  list_sprints: read('List sprints'),
  get_active_sprint: read('Get active sprints'),
  create_sprint: add('Create sprint'),
  update_sprint: mutate('Update sprint'),
  start_sprint: mutate('Start sprint'),
  complete_sprint: mutate('Complete sprint'),
  deactivate_sprint: mutate('Deactivate sprint'),
  reopen_sprint: mutate('Reopen sprint'),
  archive_sprint: mutate('Archive sprint'),
  restore_sprint: mutate('Restore sprint'),
  destroy_sprint: destroy('Destroy sprint'),
  list_tags: read('List tags'),
  create_tag: add('Create tag'),
  update_tag: mutate('Update tag'),
  delete_tag: destroy('Delete tag'),
  add_tag_to_card: add('Add tag to card'),
  remove_tag_from_card: mutate('Remove tag from card'),
  issue_upload_token: add('Issue upload token')
} as const satisfies Record<string, ToolContract>

export function withToolContract(
  name: string,
  config: Record<string, unknown>
) {
  const contract = toolContracts[name as keyof typeof toolContracts]
  if (!contract) throw new Error(`Missing MCP tool contract: ${name}`)

  return {
    ...config,
    ...contract,
    outputSchema: outputSchemaFor(name as keyof typeof toolContracts)
  }
}
