import { Effect, Match, Option, Schema } from "effect"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import { m } from "foldkit/message"
import * as Render from "foldkit/render"
import { evo } from "foldkit/struct"

export const TransitionState = Schema.Literals(["Idle", "EnterStart", "EnterAnimating", "LeaveStart", "LeaveAnimating"])

export type TransitionState = typeof TransitionState.Type

export const AnimationModel = Schema.Struct({
  id: Schema.String,
  isShowing: Schema.Boolean,
  transitionState: TransitionState,
})

export type AnimationModel = typeof AnimationModel.Type

export const Model = Schema.Struct({
  id: Schema.String,
  isOpen: Schema.Boolean,
  isAnimated: Schema.Boolean,
  animation: AnimationModel,
  maybeFocusSelector: Schema.Option(Schema.String),
})

export type Model = typeof Model.Type

export type InitConfig = Readonly<{
  id: string
  isOpen?: boolean
  isAnimated?: boolean
  focusSelector?: string
}>

export const Showed = m("Showed")
export const Hid = m("Hid")
export const AdvancedAnimationFrame = m("AdvancedAnimationFrame")
export const EndedAnimation = m("EndedAnimation")
export const AnimationMessage = Schema.Union([Showed, Hid, AdvancedAnimationFrame, EndedAnimation])

export const StartedLeaveAnimating = m("StartedLeaveAnimating")
export const TransitionedOut = m("TransitionedOut")
export const AnimationOutMessage = Schema.Union([StartedLeaveAnimating, TransitionedOut])

export const RequestedOpen = m("RequestedOpen")
export const RequestedClose = m("RequestedClose")
export const CompletedShowDialog = m("CompletedShowDialog")
export const CompletedCloseDialog = m("CompletedCloseDialog")
export const Unmounted = m("Unmounted")
export const CompletedReleaseDialogResources = m("CompletedReleaseDialogResources")
export const GotAnimationMessage = m("GotAnimationMessage", { message: AnimationMessage })

export const Message = Schema.Union([
  RequestedOpen,
  RequestedClose,
  CompletedShowDialog,
  CompletedCloseDialog,
  Unmounted,
  CompletedReleaseDialogResources,
  GotAnimationMessage,
])

export type RequestedOpen = typeof RequestedOpen.Type
export type RequestedClose = typeof RequestedClose.Type
export type CompletedShowDialog = typeof CompletedShowDialog.Type
export type CompletedCloseDialog = typeof CompletedCloseDialog.Type
export type Unmounted = typeof Unmounted.Type
export type CompletedReleaseDialogResources = typeof CompletedReleaseDialogResources.Type
export type Message = typeof Message.Type

export const Opened = m("Opened")
export const Closed = m("Closed")
export const OutMessage = Schema.Union([Opened, Closed])

export type Opened = typeof Opened.Type
export type Closed = typeof Closed.Type
export type OutMessage = typeof OutMessage.Type

const selector = (id: string): string => `#${id}`

const animationInit = (config: Readonly<{ id: string; isShowing?: boolean }>): AnimationModel => ({
  id: config.id,
  isShowing: config.isShowing ?? false,
  transitionState: "Idle",
})

export const init = (config: InitConfig): Model => ({
  id: config.id,
  isOpen: config.isOpen ?? false,
  isAnimated: config.isAnimated ?? false,
  animation: animationInit({
    id: `${config.id}-panel`,
    ...(config.isOpen === undefined ? {} : { isShowing: config.isOpen }),
  }),
  maybeFocusSelector: Option.fromNullishOr(config.focusSelector),
})

export const RequestFrame = Command.define(
  "RequestFrame",
  AdvancedAnimationFrame,
)(Render.afterPaint.pipe(Effect.as(AdvancedAnimationFrame())))

export const WaitForAnimationSettled = Command.define(
  "WaitForAnimationSettled",
  { id: Schema.String },
  EndedAnimation,
)(({ id }) => Dom.waitForAnimationSettled(selector(id)).pipe(Effect.as(EndedAnimation())))

type AnimationUpdateReturn = readonly [
  AnimationModel,
  ReadonlyArray<Command.Command<typeof AnimationMessage.Type>>,
  Option.Option<typeof AnimationOutMessage.Type>,
]

const withAnimationUpdateReturn = Match.withReturnType<AnimationUpdateReturn>()

const animationUpdate = (model: AnimationModel, message: typeof AnimationMessage.Type): AnimationUpdateReturn =>
  Match.value(message).pipe(
    withAnimationUpdateReturn,
    Match.tagsExhaustive({
      Showed: () =>
        model.isShowing
          ? [model, [], Option.none()]
          : [
              evo(model, {
                isShowing: () => true,
                transitionState: () => "EnterStart",
              }),
              [RequestFrame()],
              Option.none(),
            ],
      Hid: () => {
        const isLeaving = model.transitionState === "LeaveStart" || model.transitionState === "LeaveAnimating"
        return isLeaving || !model.isShowing
          ? [model, [], Option.none()]
          : [
              evo(model, {
                isShowing: () => false,
                transitionState: () => "LeaveStart",
              }),
              [RequestFrame()],
              Option.none(),
            ]
      },
      AdvancedAnimationFrame: () =>
        Match.value(model.transitionState).pipe(
          withAnimationUpdateReturn,
          Match.when("EnterStart", () => [
            evo(model, { transitionState: () => "EnterAnimating" }),
            [WaitForAnimationSettled({ id: model.id })],
            Option.none(),
          ]),
          Match.when("LeaveStart", () => [
            evo(model, { transitionState: () => "LeaveAnimating" }),
            [],
            Option.some(StartedLeaveAnimating()),
          ]),
          Match.orElse(() => [model, [], Option.none()]),
        ),
      EndedAnimation: () =>
        Match.value(model.transitionState).pipe(
          withAnimationUpdateReturn,
          Match.when("EnterAnimating", () => [evo(model, { transitionState: () => "Idle" }), [], Option.none()]),
          Match.when("LeaveAnimating", () => [
            evo(model, { transitionState: () => "Idle" }),
            [],
            Option.some(TransitionedOut()),
          ]),
          Match.orElse(() => [model, [], Option.none()]),
        ),
    }),
  )

const animationDefaultLeaveCommand = (model: AnimationModel): Command.Command<typeof AnimationMessage.Type> =>
  WaitForAnimationSettled({ id: model.id })

export const ShowDialog = Command.define(
  "ShowDialog",
  { id: Schema.String, maybeFocusSelector: Schema.Option(Schema.String) },
  CompletedShowDialog,
)(({ id, maybeFocusSelector }) =>
  Dom.lockScroll.pipe(
    Effect.andThen(() =>
      Dom.showDialog(
        selector(id),
        Option.match(maybeFocusSelector, {
          onNone: () => undefined,
          onSome: (focusSelector) => ({ focusSelector }),
        }),
      ),
    ),
    Effect.ignore,
    Effect.as(CompletedShowDialog()),
  ),
)

export const CloseDialog = Command.define(
  "CloseDialog",
  { id: Schema.String },
  CompletedCloseDialog,
)(({ id }) =>
  Dom.closeDialog(selector(id)).pipe(
    Effect.andThen(() => Dom.unlockScroll),
    Effect.ignore,
    Effect.as(CompletedCloseDialog()),
  ),
)

export const ReleaseDialogResources = Command.define(
  "ReleaseDialogResources",
  { id: Schema.String },
  CompletedReleaseDialogResources,
)(({ id }) => Dom.releaseDialogResources(id).pipe(Effect.ignore, Effect.as(CompletedReleaseDialogResources())))

export type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>, Option.Option<OutMessage>]

const withUpdateReturn = Match.withReturnType<UpdateReturn>()

const wrapAnimationMessage = (message: typeof AnimationMessage.Type): Message => GotAnimationMessage({ message })

const delegateToAnimation = (model: Model, animationMessage: typeof AnimationMessage.Type): UpdateReturn => {
  const [animation, animationCommands, maybeOutMessage] = animationUpdate(model.animation, animationMessage)
  const mappedCommands = Command.mapMessages(animationCommands, wrapAnimationMessage)
  const additionalCommands = Option.match(maybeOutMessage, {
    onNone: () => [],
    onSome: Match.type<typeof AnimationOutMessage.Type>().pipe(
      Match.tagsExhaustive({
        StartedLeaveAnimating: () => [
          Command.mapMessage(animationDefaultLeaveCommand(animation), wrapAnimationMessage),
        ],
        TransitionedOut: () => [CloseDialog({ id: model.id })],
      }),
    ),
  })

  return [evo(model, { animation: () => animation }), [...mappedCommands, ...additionalCommands], Option.none()]
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Match.value(message).pipe(
    withUpdateReturn,
    Match.tagsExhaustive({
      RequestedOpen: () => {
        const wasClosed = !model.isOpen
        const showCommands = wasClosed
          ? [ShowDialog({ id: model.id, maybeFocusSelector: model.maybeFocusSelector })]
          : []
        const outMessage = wasClosed ? Option.some(Opened()) : Option.none()
        if (model.isAnimated) {
          const [nextModel, animationCommands] = delegateToAnimation(model, Showed())
          return [evo(nextModel, { isOpen: () => true }), [...showCommands, ...animationCommands], outMessage]
        }
        return [evo(model, { isOpen: () => true }), showCommands, outMessage]
      },
      RequestedClose: () => {
        const isLeaving =
          model.animation.transitionState === "LeaveStart" || model.animation.transitionState === "LeaveAnimating"
        if (isLeaving) return [model, [], Option.none()]
        const wasOpen = model.isOpen
        const outMessage = wasOpen ? Option.some(Closed()) : Option.none()
        if (model.isAnimated) {
          const [nextModel, animationCommands] = delegateToAnimation(evo(model, { isOpen: () => false }), Hid())
          return [nextModel, animationCommands, outMessage]
        }
        return [evo(model, { isOpen: () => false }), wasOpen ? [CloseDialog({ id: model.id })] : [], outMessage]
      },
      GotAnimationMessage: ({ message: animationMessage }) => delegateToAnimation(model, animationMessage),
      Unmounted: () => {
        const isHoldingResources = model.isOpen || model.animation.transitionState !== "Idle"
        return isHoldingResources
          ? [
              evo(model, {
                isOpen: () => false,
                animation: () => animationInit({ id: `${model.id}-panel` }),
              }),
              [ReleaseDialogResources({ id: model.id })],
              Option.none(),
            ]
          : [model, [], Option.none()]
      },
      CompletedShowDialog: () => [model, [], Option.none()],
      CompletedCloseDialog: () => [model, [], Option.none()],
      CompletedReleaseDialogResources: () => [model, [], Option.none()],
    }),
  )

export const open = (model: Model): UpdateReturn => update(model, RequestedOpen())

export const close = (model: Model): UpdateReturn => update(model, RequestedClose())

export const titleId = (model: Model): string => `${model.id}-title`

export const descriptionId = (model: Model): string => `${model.id}-description`
