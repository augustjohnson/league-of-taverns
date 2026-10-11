/**
 * Portrait body plans: what kind of shape a character is, which picks the
 * prompt's anchor and framing (content/images/style.yaml portrait.bodyPlans).
 * Its own module so the character schema can use it without loading the style.
 */
export const BODY_PLANS = ['humanoid', 'beast', 'winged', 'blob', 'swarm', 'object', 'plant', 'multihead'] as const;
export type BodyPlan = (typeof BODY_PLANS)[number];
