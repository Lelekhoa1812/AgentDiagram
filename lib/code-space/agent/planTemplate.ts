export const PLAN_ARTIFACT_SECTION_TITLES = ['Summary', 'Key Changes', 'Test Plans', 'Assumptions'] as const;

export function formatPlanArtifactSectionHeading(title: string): string {
  return `## ${title}`;
}
