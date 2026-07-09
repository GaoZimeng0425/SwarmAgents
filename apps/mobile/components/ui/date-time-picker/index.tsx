'use client'

import React, { useCallback, useMemo } from 'react'
import {
  createDateTimePicker,
  DateTimePickerProvider,
  useDateTimePicker,
} from '@gluestack-ui/core/date-time-picker/creator'
import { UIIcon } from '@gluestack-ui/core/icon/creator'
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils'
import { useStyleContext, withStyleContext } from '@gluestack-ui/utils/nativewind-utils'
import DateTimePickerNative from '@react-native-community/datetimepicker'
import { styled } from 'nativewind'
import { Modal, Platform, Pressable, Text, TextInput, View } from 'react-native'

import {
  dateTimePickerIconStyle,
  dateTimePickerInputStyle,
  dateTimePickerStyle,
  dateTimePickerTriggerStyle,
} from './styles'

const SCOPE = 'DATE_TIME_PICKER'

export type DateTimePickerMode = 'date' | 'time' | 'datetime'

export interface DateTimePickerProps {
  value?: Date
  onChange?: (date: Date | undefined) => void
  mode?: DateTimePickerMode
  minimumDate?: Date
  maximumDate?: Date
  locale?: string
  timeZoneOffsetInMinutes?: number
  is24Hour?: boolean
  disabled?: boolean
  placeholder?: string
  format?: string
  display?: 'modal' | 'inline' // iOS only: 'modal' shows picker in modal with backdrop, 'inline' shows picker directly
  children?: React.ReactNode
}

const DateTimePickerTriggerWrapper = React.forwardRef<
  React.ComponentRef<typeof Pressable>,
  React.ComponentProps<typeof Pressable>
>(function DateTimePickerTriggerWrapper({ ...props }, ref) {
  return <Pressable {...props} ref={ref} />
})

const StyledTextInput = styled(TextInput, {
  className: { target: 'style', nativeStyleToProp: { textAlign: true } },
})

const StyledUIIcon = styled(UIIcon, {
  className: 'style',
})

const UIDateTimePicker = createDateTimePicker({
  Root: withStyleContext(View, SCOPE),
  Trigger: withStyleContext(DateTimePickerTriggerWrapper, SCOPE),
  Input: StyledTextInput,
  Icon: StyledUIIcon,
})

type IDateTimePickerProps = VariantProps<typeof dateTimePickerStyle> & DateTimePickerProps & { className?: string }

const DateTimePicker = React.forwardRef<React.ComponentRef<typeof UIDateTimePicker>, IDateTimePickerProps>(
  function DateTimePicker(
    {
      className,
      value,
      onChange,
      mode = 'datetime',
      minimumDate,
      maximumDate,
      locale,
      timeZoneOffsetInMinutes,
      is24Hour,
      disabled,
      placeholder,
      format,
      display = 'modal', // Default to modal for iOS
      children,
      ...props
    },
    ref
  ) {
    const handleNativeChange = useCallback(
      (event: any, selectedDate?: Date) => {
        // The native picker handles its own close
        if (selectedDate) {
          onChange?.(selectedDate)
        }
      },
      [onChange]
    )

    // On iOS, use custom trigger + spinner in modal or inline
    if (Platform.OS === 'ios') {
      return (
        <DateTimePickerProvider
          disabled={disabled}
          format={format}
          is24Hour={is24Hour}
          locale={locale}
          maximumDate={maximumDate}
          minimumDate={minimumDate}
          mode={mode}
          onChange={onChange}
          placeholder={placeholder}
          timeZoneOffsetInMinutes={timeZoneOffsetInMinutes}
          value={value}
        >
          <UIDateTimePicker className={dateTimePickerStyle({ class: className })} ref={ref} {...props}>
            {children}
          </UIDateTimePicker>
          {/* iOS spinner picker shown in modal or inline based on display prop */}
          <IOSDateTimePicker
            display={display}
            is24Hour={is24Hour}
            maximumDate={maximumDate}
            minimumDate={minimumDate}
            mode={mode}
            onChange={handleNativeChange}
            timeZoneOffsetInMinutes={timeZoneOffsetInMinutes}
            value={value}
          />
        </DateTimePickerProvider>
      )
    }

    return (
      <DateTimePickerProvider
        disabled={disabled}
        format={format}
        is24Hour={is24Hour}
        locale={locale}
        maximumDate={maximumDate}
        minimumDate={minimumDate}
        mode={mode}
        onChange={onChange}
        placeholder={placeholder}
        timeZoneOffsetInMinutes={timeZoneOffsetInMinutes}
        value={value}
      >
        <UIDateTimePicker className={dateTimePickerStyle({ class: className })} ref={ref} {...props}>
          {children}
        </UIDateTimePicker>
        {/* Native picker is rendered directly on Android */}
        <DateTimePickerNativeWrapper
          is24Hour={is24Hour}
          maximumDate={maximumDate}
          minimumDate={minimumDate}
          mode={mode}
          onChange={handleNativeChange}
          timeZoneOffsetInMinutes={timeZoneOffsetInMinutes}
          value={value}
        />
      </DateTimePickerProvider>
    )
  }
)

// Separate component to handle the native picker display (Android only)
function DateTimePickerNativeWrapper({
  value,
  mode,
  minimumDate,
  maximumDate,
  timeZoneOffsetInMinutes,
  is24Hour,
  onChange,
}: {
  value?: Date
  mode: DateTimePickerMode
  minimumDate?: Date
  maximumDate?: Date
  timeZoneOffsetInMinutes?: number
  is24Hour?: boolean
  onChange: (event: any, date?: Date) => void
}) {
  const { isOpen, setIsOpen } = useDateTimePicker()

  const handleChange = useCallback(
    (event: any, selectedDate?: Date) => {
      setIsOpen(false)
      onChange(event, selectedDate)
    },
    [onChange, setIsOpen]
  )

  // Android doesn't support 'datetime' mode - use two-step picker
  if (mode === 'datetime') {
    return (
      <AndroidDateTimePicker
        is24Hour={is24Hour}
        isOpen={isOpen}
        maximumDate={maximumDate}
        minimumDate={minimumDate}
        onChange={onChange}
        setIsOpen={setIsOpen}
        value={value}
      />
    )
  }

  // Android: Use display="default" which opens system dialogs for date/time
  if (!isOpen) return null

  return (
    <DateTimePickerNative
      display="default"
      is24Hour={is24Hour}
      key={`picker-${mode}`}
      maximumDate={maximumDate}
      minimumDate={minimumDate}
      mode={mode}
      onChange={handleChange}
      timeZoneOffsetInMinutes={timeZoneOffsetInMinutes}
      value={value || new Date()}
    />
  )
}

// Android-specific datetime picker (uses two separate pickers)
function AndroidDateTimePicker({
  value,
  minimumDate,
  maximumDate,
  is24Hour,
  isOpen,
  onChange,
  setIsOpen,
}: {
  value?: Date
  minimumDate?: Date
  maximumDate?: Date
  is24Hour?: boolean
  isOpen: boolean
  onChange: (event: any, date?: Date) => void
  setIsOpen: (open: boolean) => void
}) {
  const [step, setStep] = React.useState<'date' | 'time' | null>(null)
  const [tempDate, setTempDate] = React.useState<Date | undefined>(value)

  React.useEffect(() => {
    if (isOpen) {
      setStep('date')
      setTempDate(value || new Date())
    } else {
      setStep(null)
    }
  }, [isOpen, value])

  const handleDateChange = React.useCallback(
    (event: any, selectedDate?: Date) => {
      if (selectedDate) {
        setTempDate(selectedDate)
        setStep('time')
      } else {
        setIsOpen(false)
      }
    },
    [setIsOpen]
  )

  const handleTimeChange = React.useCallback(
    (event: any, selectedTime?: Date) => {
      setIsOpen(false)
      setStep(null)
      if (selectedTime && tempDate) {
        // Combine date and time
        const combinedDate = new Date(tempDate)
        combinedDate.setHours(selectedTime.getHours())
        combinedDate.setMinutes(selectedTime.getMinutes())
        onChange(event, combinedDate)
      } else if (selectedTime) {
        onChange(event, selectedTime)
      }
    },
    [tempDate, onChange, setIsOpen]
  )

  if (!isOpen || !step) return null

  if (step === 'date') {
    return (
      <DateTimePickerNative
        display="default"
        key="android-date"
        maximumDate={maximumDate}
        minimumDate={minimumDate}
        mode="date"
        onChange={handleDateChange}
        value={tempDate || new Date()}
      />
    )
  }

  return (
    <DateTimePickerNative
      display="default"
      is24Hour={is24Hour}
      key="android-time"
      mode="time"
      onChange={handleTimeChange}
      value={tempDate || new Date()}
    />
  )
}

// iOS-specific picker with spinner in modal or inline
function IOSDateTimePicker({
  value,
  mode,
  minimumDate,
  maximumDate,
  timeZoneOffsetInMinutes,
  is24Hour,
  display,
  onChange,
}: {
  value?: Date
  mode: DateTimePickerMode
  minimumDate?: Date
  maximumDate?: Date
  timeZoneOffsetInMinutes?: number
  is24Hour?: boolean
  display: 'modal' | 'inline'
  onChange: (event: any, date?: Date) => void
}) {
  const { isOpen, setIsOpen } = useDateTimePicker()
  const [tempValue, setTempValue] = React.useState(value || new Date())

  // Update temp value when picker opens
  React.useEffect(() => {
    if (isOpen) {
      setTempValue(value || new Date())
    }
  }, [isOpen, value])

  const handleChange = React.useCallback(
    (event: any, selectedDate?: Date) => {
      if (selectedDate) {
        setTempValue(selectedDate)
        // Update the parent immediately for live feedback
        onChange(event, selectedDate)
      }
    },
    [onChange]
  )

  const handleDone = React.useCallback(() => {
    setIsOpen(false)
  }, [setIsOpen])

  const handleCancel = React.useCallback(() => {
    setIsOpen(false)
    // Revert to original value
    if (value) {
      onChange({ type: 'dismissed' }, value)
    }
  }, [setIsOpen, onChange, value])

  if (!isOpen) return null

  // Inline mode: show picker directly without modal
  if (display === 'inline') {
    return (
      <View className="w-full">
        <DateTimePickerNative
          display="spinner"
          is24Hour={is24Hour}
          maximumDate={maximumDate}
          minimumDate={minimumDate}
          mode={mode}
          onChange={handleChange}
          timeZoneOffsetInMinutes={timeZoneOffsetInMinutes}
          value={tempValue}
        />
      </View>
    )
  }

  // Modal mode: show picker in modal with backdrop
  return (
    <Modal animationType="slide" onRequestClose={handleCancel} transparent={true} visible={isOpen}>
      <View className="flex-1 justify-end">
        {/* Backdrop - separate touchable area */}
        <Pressable className="absolute inset-0 bg-black/50" onPress={handleCancel} />
        {/* Picker container */}
        <View className="relative rounded-t-lg bg-background p-4">
          <View className="mb-4 flex-row items-center justify-between border-border border-b pb-2">
            <Pressable onPress={handleCancel}>
              <Text className="font-semibold text-base text-primary">Cancel</Text>
            </Pressable>
            <Text className="font-semibold text-base text-foreground">
              {mode === 'date' ? 'Select Date' : mode === 'time' ? 'Select Time' : 'Select Date & Time'}
            </Text>
            <Pressable onPress={handleDone}>
              <Text className="font-semibold text-base text-primary">Done</Text>
            </Pressable>
          </View>
          <DateTimePickerNative
            display="spinner"
            is24Hour={is24Hour}
            maximumDate={maximumDate}
            minimumDate={minimumDate}
            mode={mode}
            onChange={handleChange}
            timeZoneOffsetInMinutes={timeZoneOffsetInMinutes}
            value={tempValue}
          />
        </View>
      </View>
    </Modal>
  )
}

type IDateTimePickerTriggerProps = VariantProps<typeof dateTimePickerTriggerStyle> &
  React.ComponentProps<typeof UIDateTimePicker.Trigger> & {
    className?: string
  }

const DateTimePickerTrigger = React.forwardRef<
  React.ComponentRef<typeof UIDateTimePicker.Trigger>,
  IDateTimePickerTriggerProps
>(function DateTimePickerTrigger({ className, size = 'md', variant = 'outline', ...props }, ref) {
  const { disabled, setIsOpen } = useDateTimePicker()

  return (
    <UIDateTimePicker.Trigger
      className={dateTimePickerTriggerStyle({
        class: className,
        size,
        variant,
      })}
      context={{ size, variant }}
      disabled={disabled}
      onPress={() => !disabled && setIsOpen(true)}
      ref={ref}
      {...props}
    />
  )
})

type IDateTimePickerInputProps = VariantProps<typeof dateTimePickerInputStyle> &
  React.ComponentProps<typeof UIDateTimePicker.Input> & { className?: string }

const DateTimePickerInput = React.forwardRef<
  React.ComponentRef<typeof UIDateTimePicker.Input>,
  IDateTimePickerInputProps
>(function DateTimePickerInput({ className, ...props }, ref) {
  const { size: parentSize, variant: parentVariant } = useStyleContext(SCOPE)
  const { value, placeholder, format } = useDateTimePicker()

  const displayValue = useMemo(() => {
    if (!value) return ''
    if (format) {
      return formatDate(value, format)
    }
    return value.toLocaleString()
  }, [value, format])

  return (
    <UIDateTimePicker.Input
      className={dateTimePickerInputStyle({
        class: className,
        parentVariants: {
          size: parentSize,
          variant: parentVariant,
        },
      })}
      editable={false}
      placeholder={placeholder}
      ref={ref}
      style={{ pointerEvents: 'none' }}
      value={displayValue}
      {...props}
    />
  )
})

type IDateTimePickerIconProps = VariantProps<typeof dateTimePickerIconStyle> &
  React.ComponentProps<typeof UIDateTimePicker.Icon> & { className?: string }

const DateTimePickerIcon = React.forwardRef<React.ComponentRef<typeof UIDateTimePicker.Icon>, IDateTimePickerIconProps>(
  function DateTimePickerIcon({ className, size, ...props }, ref) {
    const { size: parentSize } = useStyleContext(SCOPE)

    if (typeof size === 'number') {
      return (
        <UIDateTimePicker.Icon
          ref={ref}
          {...props}
          className={dateTimePickerIconStyle({ class: className })}
          size={size}
        />
      )
    }

    return (
      <UIDateTimePicker.Icon
        className={dateTimePickerIconStyle({
          class: className,
          size,
          parentVariants: {
            size: parentSize,
          },
        })}
        ref={ref}
        {...props}
      />
    )
  }
)

function formatDate(date: Date, format: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return format
    .replace('YYYY', date.getFullYear().toString())
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()))
}

export { DateTimePicker, DateTimePickerIcon, DateTimePickerInput, DateTimePickerTrigger }
